import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";
import type { CaseBible } from "@paw-order/shared";

/**
 * One generated trial. The whole Case Bible lives in a single json column:
 * nothing queries inside it, and the generator rewrites it wholesale.
 * `simple-json` is the portable column type — sqlite in dev, jsonb-ish text on
 * Postgres. Switch to `jsonb` only when a query needs to reach inside.
 */
@Entity("cases")
export class CaseEntity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column("simple-json")
    bible!: CaseBible;

    @CreateDateColumn()
    createdAt!: Date;
}
