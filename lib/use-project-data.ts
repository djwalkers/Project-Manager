"use client";

import { useEffect, useState } from "react";
import type { DataStore } from "@/lib/data-store";
import { loadData } from "@/lib/supabase/data-store";

export function useProjectData() {
  const [data, setData] = useState<DataStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    loadData()
      .then((next) => active && setData(next))
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unknown data source error");
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  return { data, setData, error, reload: () => setReloadKey((value) => value + 1) };
}
