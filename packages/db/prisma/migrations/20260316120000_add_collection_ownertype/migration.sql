-- AlterEnum: add 'collection' value to OwnerType
ALTER TYPE "OwnerType" ADD VALUE IF NOT EXISTS 'collection';
