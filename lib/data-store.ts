"use client";

import { seedData } from "@/lib/seed-data";
import type { EntityMap, EntityName } from "@/lib/types";

const storageKey = "project-manager-cr028-data-v1";

export type DataStore = {
  [K in EntityName]: EntityMap[K][];
};

export function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadData(): DataStore {
  if (typeof window === "undefined") return structuredClone(seedData) as DataStore;
  const stored = window.localStorage.getItem(storageKey);
  if (!stored) return structuredClone(seedData) as DataStore;

  try {
    const parsed = JSON.parse(stored) as Partial<DataStore>;
    return Object.fromEntries(
      Object.entries(seedData).map(([key, seedRows]) => {
        const storedRows = parsed[key as EntityName] ?? [];
        const seeded = seedRows.map((seedRow) => ({
          ...seedRow,
          ...storedRows.find((storedRow) => storedRow.id === seedRow.id),
        }));
        const seededIds = new Set(seedRows.map((row) => row.id));
        return [key, [...storedRows.filter((row) => !seededIds.has(row.id)), ...seeded]];
      }),
    ) as DataStore;
  } catch {
    return structuredClone(seedData) as DataStore;
  }
}

export function saveData(data: DataStore) {
  window.localStorage.setItem(storageKey, JSON.stringify(data));
}

export function resetData() {
  window.localStorage.removeItem(storageKey);
}
