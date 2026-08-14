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
    rm -f schema.sql migrations_data.sql
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
    bash -c 'pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL"' > schema.sql

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
PGPASSWORD=postgres psql -q -h localhost -p "$LOCAL_PORT" -U postgres -d drift_check < schema.sql

# The migrations table tells TypeORM which migrations prod has already applied.
# Without it every committed migration re-runs against a schema that already has
# them, and the run fails on "relation already exists" rather than reporting drift.
echo "Copying the migration history..."
if docker run --rm --network=host -e DATABASE_URL="$DATABASE_URL" "$PG_IMAGE" \
    bash -c 'pg_dump --data-only --inserts --table=migrations "$DATABASE_URL"' > migrations_data.sql 2>/dev/null; then
    PGPASSWORD=postgres psql -q -h localhost -p "$LOCAL_PORT" -U postgres -d drift_check < migrations_data.sql
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
GENERATED="${MIGRATIONS_DIR}/9999999999999-DriftCheck"
set +e
npx typeorm migration:generate "$GENERATED" -d "$DIST_DATA_SOURCE"
GENERATE_EXIT=$?
set -e

# TypeORM exits 1 with "No changes in database schema were found" when the
# entities and the schema already agree. That is the success case here.
if [ "$GENERATE_EXIT" -eq 1 ]; then
    echo "No drift: the committed migrations describe the production schema."
    exit 0
fi

if [ "$GENERATE_EXIT" -ne 0 ]; then
    echo "ERROR: migration generation failed with exit code ${GENERATE_EXIT}"
    exit "$GENERATE_EXIT"
fi

DRIFT_FILE="${GENERATED}.ts"
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
