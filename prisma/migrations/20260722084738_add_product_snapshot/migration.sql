-- CreateTable
CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentInventory" INTEGER NOT NULL,
    "unitsSoldLast7Days" INTEGER NOT NULL,
    "unitsSoldPrevious30DaysDailyAvg" REAL NOT NULL,
    "daysSinceLastSale" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ProductSnapshot_shop_idx" ON "ProductSnapshot"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSnapshot_shop_productId_key" ON "ProductSnapshot"("shop", "productId");
