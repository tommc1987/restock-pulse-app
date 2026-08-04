-- CreateTable
CREATE TABLE "BillingFailure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "errorCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestedAction" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "occurredAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "BillingFailure_shop_idx" ON "BillingFailure"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "BillingFailure_shop_contractId_occurredAt_key" ON "BillingFailure"("shop", "contractId", "occurredAt");
