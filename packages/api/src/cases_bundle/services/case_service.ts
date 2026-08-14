import type { PublicCase } from "@paw-order/shared";
import type { GeneratedImage } from "@/ai/gemini";
import { AppDataSource } from "@/database_bundle/util/data_source";
import { CaseEntity } from "@/cases_bundle/models/case_entity";
import { generateCaseBible } from "@/cases_bundle/services/case_generator";
import { uploadImage } from "@/storage/r2";

function repository() {
    return AppDataSource.getRepository(CaseEntity);
}

/** Strips the hidden truth. The client only sees this shape mid-trial. */
function toPublicCase(entity: CaseEntity): PublicCase {
    const { truth: _truth, ...rest } = entity.bible;
    return { id: entity.id, ...rest };
}

export async function createCase(photo: GeneratedImage): Promise<PublicCase> {
    const photoUrl = await uploadImage(photo.bytes, photo.mimeType, "dogs");
    const bible = await generateCaseBible(photoUrl, photo);
    const saved = await repository().save(repository().create({ bible }));
    return toPublicCase(saved);
}

export async function findPublicCase(id: string): Promise<PublicCase | null> {
    const entity = await repository().findOne({ where: { id } });
    return entity ? toPublicCase(entity) : null;
}
