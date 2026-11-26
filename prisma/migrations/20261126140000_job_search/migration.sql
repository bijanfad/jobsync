-- "Find jobs": saved searches over job portals and career pages
ALTER TABLE "JobRankingRow" ADD COLUMN IF NOT EXISTS "source" TEXT;

CREATE TABLE IF NOT EXISTS "JobSearch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "location" TEXT,
    "radiusKm" INTEGER NOT NULL DEFAULT 30,
    "maxAgeDays" INTEGER NOT NULL DEFAULT 7,
    "sources" TEXT NOT NULL,
    "companies" TEXT NOT NULL DEFAULT '{}',
    "daily" BOOLEAN NOT NULL DEFAULT true,
    "rankingId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastRunAt" TIMESTAMP(3),
    "lastRun" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobSearch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobSearch_userId_idx" ON "JobSearch"("userId");
CREATE INDEX IF NOT EXISTS "JobSearch_daily_lastRunAt_idx" ON "JobSearch"("daily", "lastRunAt");

DO $$ BEGIN
  ALTER TABLE "JobSearch" ADD CONSTRAINT "JobSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
