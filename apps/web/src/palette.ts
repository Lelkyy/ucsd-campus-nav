/**
 * The app's palette, "Evergreen Dreams": deep olive #595E48, sage #919682,
 * light sage #C7CDBF, clay #C7A491 and blush #EECFCA, plus a few deeper tones
 * of the same colors where a line or pin needs contrast on the map.
 * (The CSS uses the same colors as custom properties in styles.css.)
 */
export const PALETTE = {
  olive: "#595E48",
  oliveDeep: "#3B3F2F",
  sage: "#919682",
  sageDeep: "#6F7658",
  sageLight: "#C7CDBF",
  clay: "#C7A491",
  clayDeep: "#9C7058",
  blush: "#EECFCA",
  rose: "#B4655B",
  ink: "#2B2E24",
  white: "#FFFFFF",
} as const;

/** Course colors (schedule, day view, day map): palette tones dark enough for white text on them. */
export const COURSE_COLORS = ["#595E48", "#9C7058", "#7C8466", "#B4655B", "#3F4A3C", "#8E7A5C", "#5F7468", "#8C6676"];
