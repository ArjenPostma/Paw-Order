import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1786819196924 implements MigrationInterface {
    name = "Migration1786819196924";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "cases"
            ADD "photoHash" character varying(64)
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_535edb9f5977142c6508c2a5bb" ON "cases" ("photoHash")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."IDX_535edb9f5977142c6508c2a5bb"
        `);
        await queryRunner.query(`
            ALTER TABLE "cases" DROP COLUMN "photoHash"
        `);
    }
}
