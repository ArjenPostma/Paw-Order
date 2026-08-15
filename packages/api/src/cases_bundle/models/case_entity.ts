import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { CaseBible, CaseStatus } from "@paw-order/shared";

/**
 * One generated trial. The whole Case Bible lives in a single json column:
 * nothing queries inside it, and the generator rewrites it wholesale.
 *
 * `simple-json` compiles to plain `text` on BOTH sqlite and Postgres - not
 * jsonb. There is no validity constraint, no containment operator, no GIN
 * index, and no partial read; TypeORM JSON.parses the whole string on every
 * find. Moving to jsonb later is a rewrite migration (`USING bible::jsonb`)
 * over every row, not a type annotation - weigh that before a query needs to
 * reach inside.
 *
 * ponytail: no retention policy. Rows and their paired R2 objects grow with
 * every anonymous upload; the cleanup job and the index it needs land together.
 */
@Entity("cases")
export class CaseEntity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column("simple-json")
    bible!: CaseBible;

    /**
     * The row is inserted PENDING and the bible is filled in by a background
     * job, so this is the only thing that says whether `bible` is a real case
     * or the placeholder. Serving a PENDING row's bible would ship an empty
     * trial; findCaseStatus is what enforces that.
     *
     * varchar, not a Postgres enum: an enum needs its own migration to gain a
     * value, and the union in @paw-order/shared is the real constraint.
     */
    @Column({ type: "varchar", length: 16, default: "PENDING" })
    status!: CaseStatus;

    /**
     * sha256 of the uploaded bytes together with the defendant name, so the same
     * photo submitted twice returns the case already generated for it.
     *
     * This is a convenience, NOT a cost control, and nothing may be relaxed on
     * the strength of it. It matches byte-identical uploads only: one changed
     * pixel, one byte appended past the end of the file, or "rex" for "Rex" is a
     * new digest and a full-price case. Against anyone trying to spend money it
     * saves nothing at all; what it saves is the honest player re-uploading the
     * photo they already played, and the case slot that would have cost them.
     *
     * The name is inside the digest, not beside it: the prompts write it through
     * the whole bible - the charge, the title, the timeline, every witness claim
     * and every node - so a case generated for one name cannot be relabelled
     * with another without rewriting model prose.
     *
     * Nullable because rows written before the column existed have no hash, and
     * deliberately NOT unique: a FAILED row keeps its hash, and the re-upload
     * that follows must be free to insert the same one.
     */
    @Index()
    @Column({ type: "varchar", length: 64, nullable: true })
    photoHash!: string | null;

    // TIMESTAMP without time zone (see the generated migration): the stored
    // instant carries no offset, so it is only meaningful because every writer
    // runs UTC. `timestamptz` is not an option - the sqlite driver rejects it
    // and would break dev and test. Any retention job must compare in UTC.
    @CreateDateColumn()
    createdAt!: Date;
}
