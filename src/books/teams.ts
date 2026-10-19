export interface Team {
  code: string;
  name: string;
  nickname: string;
}

// Every NFL nickname is a single unique word, so it is the most reliable join key across books:
// FD says "Washington Commanders", DK says "WAS Commanders", and abbreviations disagree (LA vs LAR).
export const NFL_TEAMS: readonly Team[] = [
  { code: 'ARI', name: 'Arizona Cardinals', nickname: 'Cardinals' },
  { code: 'ATL', name: 'Atlanta Falcons', nickname: 'Falcons' },
  { code: 'BAL', name: 'Baltimore Ravens', nickname: 'Ravens' },
  { code: 'BUF', name: 'Buffalo Bills', nickname: 'Bills' },
  { code: 'CAR', name: 'Carolina Panthers', nickname: 'Panthers' },
  { code: 'CHI', name: 'Chicago Bears', nickname: 'Bears' },
  { code: 'CIN', name: 'Cincinnati Bengals', nickname: 'Bengals' },
  { code: 'CLE', name: 'Cleveland Browns', nickname: 'Browns' },
  { code: 'DAL', name: 'Dallas Cowboys', nickname: 'Cowboys' },
  { code: 'DEN', name: 'Denver Broncos', nickname: 'Broncos' },
  { code: 'DET', name: 'Detroit Lions', nickname: 'Lions' },
  { code: 'GB', name: 'Green Bay Packers', nickname: 'Packers' },
  { code: 'HOU', name: 'Houston Texans', nickname: 'Texans' },
  { code: 'IND', name: 'Indianapolis Colts', nickname: 'Colts' },
  { code: 'JAX', name: 'Jacksonville Jaguars', nickname: 'Jaguars' },
  { code: 'KC', name: 'Kansas City Chiefs', nickname: 'Chiefs' },
  { code: 'LV', name: 'Las Vegas Raiders', nickname: 'Raiders' },
  { code: 'LAC', name: 'Los Angeles Chargers', nickname: 'Chargers' },
  { code: 'LAR', name: 'Los Angeles Rams', nickname: 'Rams' },
  { code: 'MIA', name: 'Miami Dolphins', nickname: 'Dolphins' },
  { code: 'MIN', name: 'Minnesota Vikings', nickname: 'Vikings' },
  { code: 'NE', name: 'New England Patriots', nickname: 'Patriots' },
  { code: 'NO', name: 'New Orleans Saints', nickname: 'Saints' },
  { code: 'NYG', name: 'New York Giants', nickname: 'Giants' },
  { code: 'NYJ', name: 'New York Jets', nickname: 'Jets' },
  { code: 'PHI', name: 'Philadelphia Eagles', nickname: 'Eagles' },
  { code: 'PIT', name: 'Pittsburgh Steelers', nickname: 'Steelers' },
  { code: 'SF', name: 'San Francisco 49ers', nickname: '49ers' },
  { code: 'SEA', name: 'Seattle Seahawks', nickname: 'Seahawks' },
  { code: 'TB', name: 'Tampa Bay Buccaneers', nickname: 'Buccaneers' },
  { code: 'TEN', name: 'Tennessee Titans', nickname: 'Titans' },
  { code: 'WAS', name: 'Washington Commanders', nickname: 'Commanders' },
];

const byNickname = new Map(NFL_TEAMS.map((t) => [t.nickname.toLowerCase(), t]));
const byCode = new Map(NFL_TEAMS.map((t) => [t.code.toLowerCase(), t]));

/** Resolve any book's team label ("San Francisco 49ers", "SF 49ers", "49ers", "SF") to a canonical team. */
export function resolveTeam(label: string | undefined | null): Team | null {
  if (!label) return null;
  // Real NFL listings never carry parentheses on either book; simulated/eFootball games do
  // ("Detroit Lions (CLOCKWORK)"). Rejecting them keeps a fake game from claiming a real game key.
  if (/[()]/.test(label)) return null;
  const cleaned = label.trim().toLowerCase();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/);
  return byNickname.get(words[words.length - 1]!) ?? byCode.get(cleaned) ?? null;
}

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * Cross-book game identity: kickoff date in US Eastern plus away@home codes. Books disagree on
 * kickoff by a minute or two (FD 00:16Z vs DK 00:15Z), and no NFL game starts near midnight ET,
 * so the ET calendar date is stable where the exact timestamp is not.
 */
export function gameKey(away: Team, home: Team, startTime: string | Date): string {
  return `${etDate.format(new Date(startTime))}:${away.code}@${home.code}`;
}
