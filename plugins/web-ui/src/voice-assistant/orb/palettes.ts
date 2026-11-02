export type PaletteKey = "deep" | "mid" | "light" | "high" | "accent";

export type RGB = [number, number, number];
export type PaletteRGB = Record<PaletteKey, RGB>;

export const OMNILOY_PALETTE: Readonly<Record<PaletteKey, string>> = {
  deep: "#0568c4",
  mid: "#0783f0",
  light: "#b6ddff",
  high: "#f2f8ff",
  accent: "#8fb4ff",
};

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const OMNILOY_RGB: Readonly<PaletteRGB> = {
  deep: hexToRgb(OMNILOY_PALETTE.deep),
  mid: hexToRgb(OMNILOY_PALETTE.mid),
  light: hexToRgb(OMNILOY_PALETTE.light),
  high: hexToRgb(OMNILOY_PALETTE.high),
  accent: hexToRgb(OMNILOY_PALETTE.accent),
};
