#!/bin/bash
#
# Migration drift check.
#
# Entity changes reach dev and test through synchronize:true, but reach
# production ONLY through a committed migration - and the test suite runs on
# sqlite. So an entity change with no migration passes every other check and
# fails on the first INSERT in production.
#
# This proves the committed migrations still describe the real production
# schema: dump prod's schema, restore it into a throwaway local Postgres, run
# the committed migrations against it, then ask TypeORM to generate a migration.
# A clean repo produces nothing. Anything generated is drift.
#
# Read-only against production: pg_dump --schema-only, nothing else touches it.
#
set -euo pipefail

: "${DATABASE_URL:?Missing DATABASE_URL}"

# Absolute, because this script cds into packages/api partway through and the
# EXIT trap below would otherwise try to delete the dumps relative to there,
# leaving a copy of the production schema on the runner's disk.
ROOT_DIR="$(pwd)"
SCHEMA_DUMP="${ROOT_DIR}/schema.sql"
MIGRATIONS_DUMP="${ROOT_DIR}/migrations_data.sql"
# Absolute for the same reason: the trap fires after the cd into packages/api.
DRIFT_PROBE="${ROOT_DIR}/packages/api/src/database_bundle/migrations/9999999999999-DriftCheck.ts"

API_DIR="packages/api"
DIST_DATA_SOURCE="./dist/database_bundle/util/data_source.js"
MIGRATIONS_DIR="./src/database_bundle/migrations"
CONTAINER="paw-order-drift-check"
# Client and server pinned together: a pg_dump older than the server refuses to
# run, and the runner's bundled client version is not ours to control.
PG_IMAGE="postgres:18"
LOCAL_PORT=5433

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -f "$SCHEMA_DUMP" "$MIGRATIONS_DUMP"
    # The probe migration too. Interrupting the script after generation left it
    # in the migrations directory, where it sorts last, compiles into dist, and
    # gets executed against production by the migration glob on next boot.
    rm -f "$DRIFT_PROBE"
    # Belt as well as braces: the exact name above is pinned by -t at generation
    # time, and the glob is what catches it anyway if that ever stops being true.
    # A probe left on disk is the worst outcome this script has.
    rm -f "${ROOT_DIR}"/packages/api/src/database_bundle/migrations/*-DriftCheck.ts
}
trap cleanup EXIT

if [ ! -d "${API_DIR}/dist" ]; then
    echo "ERROR: ${API_DIR}/dist not found. Run 'npm run build -w @paw-order/api' first."
    exit 1
fi

echo "Checking the production connection..."
docker run --rm --network=host -e DATABASE_URL="$DATABASE_URL" "$PG_IMAGE" \
    psql "$DATABASE_URL" -c "SELECT version();" >/dev/null || {
    echo "ERROR: cannot connect using DATABASE_URL"
    exit 1
}

echo "Dumping the production schema..."
docker run --rm --network=host -e DATABASE_URL="$DATABASE_URL" "$PG_IMAGE" \
    bash -c 'pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL"' > "$SCHEMA_DUMP"

echo "Starting a throwaway local Postgres..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run --rm -d --name "$CONTAINER" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=drift_check \
    -p "${LOCAL_PORT}:5432" "$PG_IMAGE" >/dev/null

for attempt in $(seq 1 20); do
    if PGPASSWORD=postgres psql -h localhost -p "$LOCAL_PORT" -U postgres -d postgres \
        -c "SELECT 1" >/dev/null 2>&1; then
        break
    fi
    if [ "$attempt" -eq 20 ]; then
        echo "ERROR: local Postgres did not become ready"
        exit 1
    fi
    sleep 2
done

echo "Restoring the production schema locally..."
PGPASSWORD=postgres psql -q -h localhost -p "$LOCAL_PORT" -U postgres -d drift_check < "$SCHEMA_DUMP"

# The migrations table tells TypeORM which migrations prod has already applied.
# Without it every committed migration re-runs against a schema that already has
# them, and the run fails on "relation already exists" rather than reporting drift.
echo "Copying the migration history..."
if docker run --rm --network=host -e DATABASE_URL="$DATABASE_URL" "$PG_IMAGE" \
    bash -c 'pg_dump --data-only --inserts --table=migrations "$DATABASE_URL"' > "$MIGRATIONS_DUMP" 2>/dev/null; then
    PGPASSWORD=postgres psql -q -h localhost -p "$LOCAL_PORT" -U postgres -d drift_check < "$MIGRATIONS_DUMP"
else
    echo "No migrations table in production yet (first deploy)."
fi

cd "$API_DIR"

export APP_ENV=drift_check
export DATABASE_HOST=127.0.0.1
export DATABASE_PORT="$LOCAL_PORT"
export DATABASE_NAME=drift_check
export DATABASE_USER=postgres
export DATABASE_PASSWORD=postgres

echo "Applying committed migrations..."
npx typeorm migration:run -d "$DIST_DATA_SOURCE"

echo "Generating a migration - anything produced here is drift..."
# The path is the BASE name only, and -t pins the prefix typeorm would otherwise
# stamp on from Date.now(): the written filename is always
# "<timestamp>-<basename>", so passing the timestamp in the path produced
# "<now>-9999999999999-DriftCheck.ts" and nothing here could find, print or
# delete it - a real drift reported itself as "produced no file" and left the
# probe migration behind to run against production on the next boot.
GENERATED="${MIGRATIONS_DIR}/DriftCheck"
set +e
GENERATE_OUTPUT=$(npx typeorm migration:generate "$GENERATED" -t 9999999999999 -d "$DIST_DATA_SOURCE" 2>&1)
GENERATE_EXIT=$?
set -e
echo "$GENERATE_OUTPUT"

# TypeORM exits 1 BOTH when the entities and the schema already agree and when
# the command genuinely failed - a refused connection, an unreadable data source,
# a broken build. Keying the success case off the exit code alone therefore
# reports "No drift" for a check that never actually ran, which is the one
# failure this script exists to prevent. Match the message instead.
if grep -qF "No changes in database schema were found" <<<"$GENERATE_OUTPUT"; then
    echo "No drift: the committed migrations describe the production schema."
    exit 0
fi

if [ "$GENERATE_EXIT" -ne 0 ]; then
    echo "ERROR: migration generation failed with exit code ${GENERATE_EXIT}"
    exit 1
fi

DRIFT_FILE="$DRIFT_PROBE"
if [ ! -f "$DRIFT_FILE" ]; then
    echo "ERROR: generation reported success but produced no file"
    exit 1
fi

echo "ERROR: schema drift detected. An entity changed without a committed migration."
echo "Run 'npm run typeorm:generate' against a prod-shaped database and commit the result."
echo "----------------------------------------"
cat "$DRIFT_FILE"
echo "----------------------------------------"
rm -f "$DRIFT_FILE"
exit 1
