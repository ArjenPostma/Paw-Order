import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1786738904155 implements MigrationInterface {
    name = "Migration1786738904155";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "cases"
            ADD "status" character varying(16) NOT NULL DEFAULT 'PENDING'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "cases" DROP COLUMN "status"
        `);
    }
}
