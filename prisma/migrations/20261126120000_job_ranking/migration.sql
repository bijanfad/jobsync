-- "Rank jobs": CSV rankings against all of a user's CVs
CREATE TABLE IF NOT EXISTS "JobRanking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "error" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobRanking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JobRankingRow" (
    "id" TEXT NOT NULL,
    "rankingId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT,
    "location" TEXT,
    "url" TEXT,
    "category" TEXT,
    "datePosted" TEXT,
    "language" TEXT,
    "remote" TEXT,
    "experience" TEXT,
    "skills" TEXT,
    "degree" TEXT,
    "loadStatus" TEXT NOT NULL DEFAULT 'pending',
    "loadError" TEXT,
    "finalUrl" TEXT,
    "description" TEXT,
    "score" INTEGER,
    "bestResumeId" TEXT,
    "bestResumeTitle" TEXT,
    "reason" TEXT,
    "scoreError" TEXT,
    "scoredAt" TIMESTAMP(3),
    "jobId" TEXT,
    CONSTRAINT "JobRankingRow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobRanking_userId_createdAt_idx" ON "JobRanking"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "JobRankingRow_rankingId_loadStatus_idx" ON "JobRankingRow"("rankingId", "loadStatus");
CREATE INDEX IF NOT EXISTS "JobRankingRow_rankingId_scoredAt_idx" ON "JobRankingRow"("rankingId", "scoredAt");
CREATE INDEX IF NOT EXISTS "JobRankingRow_rankingId_score_idx" ON "JobRankingRow"("rankingId", "score");

DO $$ BEGIN
  ALTER TABLE "JobRanking" ADD CONSTRAINT "JobRanking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "JobRankingRow" ADD CONSTRAINT "JobRankingRow_rankingId_fkey" FOREIGN KEY ("rankingId") REFERENCES "JobRanking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
