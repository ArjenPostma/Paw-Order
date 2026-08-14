import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1786728722008 implements MigrationInterface {
    name = "Migration1786728722008";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "cases" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "bible" text NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_264acb3048c240fb89aa34626db" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE "cases"
        `);
    }
}
