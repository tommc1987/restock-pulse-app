-- CreateTable
CREATE TABLE "ProductSaleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "occurredAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ProductSaleEvent_shop_productId_occurredAt_idx" ON "ProductSaleEvent"("shop", "productId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSaleEvent_shop_productId_orderId_key" ON "ProductSaleEvent"("shop", "productId", "orderId");
