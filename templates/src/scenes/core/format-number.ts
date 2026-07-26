/** 最終値の表記精度を保ったまま、カウントアップ中の数値を整形する。 */
export function decimalPlacesOf(target: number): number {
  if (!Number.isFinite(target) || Number.isInteger(target)) return 0;
  const text = target.toString().toLowerCase();
  if (text.includes("e")) {
    const [coefficient, exponentText] = text.split("e");
    const fractionLength = coefficient.split(".")[1]?.length ?? 0;
    const exponent = Number(exponentText);
    return Math.max(0, fractionLength - exponent);
  }
  return text.split(".")[1]?.length ?? 0;
}

export function formatAnimatedNumber(value: number, target: number): string {
  const decimals = decimalPlacesOf(target);
  if (decimals === 0) return Math.round(value).toLocaleString("en-US");
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
