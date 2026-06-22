"use client";

import { useEffect, useState } from "react";
import type { DataStore } from "@/lib/data-store";
import { loadData } from "@/lib/supabase/data-store";

export function useProjectData() {
  const [data, setData] = useState<DataStore | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    loadData()
      .then((next) => active && setData(next))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [reloadKey]);

  return { data, setData, error, reload: () => setReloadKey((value) => value + 1) };
}
