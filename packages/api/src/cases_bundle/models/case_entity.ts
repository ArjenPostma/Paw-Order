import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";
import type { CaseBible } from "@paw-order/shared";

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

    // TIMESTAMP without time zone (see the generated migration): the stored
    // instant carries no offset, so it is only meaningful because every writer
    // runs UTC. `timestamptz` is not an option - the sqlite driver rejects it
    // and would break dev and test. Any retention job must compare in UTC.
    @CreateDateColumn()
    createdAt!: Date;
}
