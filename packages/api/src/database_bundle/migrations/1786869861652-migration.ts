import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1786869861652 implements MigrationInterface {
    name = "Migration1786869861652";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "cases"
            ADD "isPublic" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "cases"
            ADD "slug" character varying(64)
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_334e33acab18c5105c2b8c3bb7" ON "cases" ("slug")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."IDX_334e33acab18c5105c2b8c3bb7"
        `);
        await queryRunner.query(`
            ALTER TABLE "cases" DROP COLUMN "slug"
        `);
        await queryRunner.query(`
            ALTER TABLE "cases" DROP COLUMN "isPublic"
        `);
    }
}
