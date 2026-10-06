// EDIT THESE DATES before launch week.
// Use ISO format with an explicit UTC offset so it fires at the right
// wall-clock time regardless of what timezone the server itself runs in.
// Example for Eastern Time (UTC-4 in September): "2026-09-10T07:00:00-04:00"

module.exports = [
  {
    emailType: "follow_kickstarter",
    label: "LW-1 -- follow CTA",
    targetDate: "2026-09-03T09:00:00-04:00",
    audience: "everyone"
  },
  {
    emailType: "launch_instructions",
    label: "LW-2 -- what to do tomorrow",
    targetDate: "2026-09-09T09:00:00-04:00",
    audience: "everyone"
  },
  {
    emailType: "vip_private_link",
    label: "LD-VIP -- reservers only, 2hrs early",
    targetDate: "2026-09-10T07:00:00-04:00",
    audience: "reservers"
  },
  {
    emailType: "we_are_live",
    label: "LD-1 -- everyone",
    targetDate: "2026-09-10T09:00:00-04:00",
    audience: "everyone"
  },
  {
    emailType: "still_live",
    label: "LD-1b -- non-openers of we_are_live",
    targetDate: "2026-09-10T18:00:00-04:00",
    audience: "non_openers_of_we_are_live"
  }
];
