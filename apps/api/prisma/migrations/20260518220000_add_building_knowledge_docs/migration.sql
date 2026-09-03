-- Building knowledge base for LLM RAG (2026-05-18)
-- Documents uploaded by building admin: Messenger chats, uchwały, regulaminy, kontakty.
-- Cloud trzyma metadata + parsed text; binary files lecą prosto na Edge filesystem.

CREATE TYPE "BuildingKnowledgeType" AS ENUM (
  'MESSENGER_CHAT',
  'UCHWALA',
  'REGULAMIN',
  'KONTAKT',
  'INNE'
);

CREATE TABLE "building_knowledge_docs" (
  "id"          SERIAL PRIMARY KEY,
  "buildingId"  INTEGER NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
  "type"        "BuildingKnowledgeType" NOT NULL,
  "title"       TEXT NOT NULL,
  "parsedText"  TEXT NOT NULL,
  "metadata"    JSONB,
  "fileExt"     TEXT,
  "fileSizeB"   INTEGER,
  "uploadedBy"  INTEGER NOT NULL,
  "uploadedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "isArchived"  BOOLEAN NOT NULL DEFAULT false,
  "archivedAt"  TIMESTAMP(3)
);

-- Index dla list endpoint (newest first per type)
CREATE INDEX "building_knowledge_docs_buildingId_type_uploadedAt_idx"
  ON "building_knowledge_docs" ("buildingId", "type", "uploadedAt" DESC);

-- Index dla soft-delete filtering
CREATE INDEX "building_knowledge_docs_buildingId_isArchived_idx"
  ON "building_knowledge_docs" ("buildingId", "isArchived");
