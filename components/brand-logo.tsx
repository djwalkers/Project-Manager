import Image from "next/image";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/** The Test Manager mark, optionally with the wordmark. Name text follows the theme foreground. */
export function BrandLogo({
  size = 32,
  showName = true,
  className,
  nameClassName,
}: {
  size?: number;
  showName?: boolean;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Image src={BRAND.logo.mark} alt={showName ? "" : BRAND.productName} width={size} height={size} priority className="shrink-0" />
      {showName && <span className={cn("font-semibold tracking-tight text-foreground", nameClassName)}>{BRAND.productName}</span>}
    </span>
  );
}
