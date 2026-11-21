/** Editorial watchlist: AI business association, not a claim of pure AI revenues. */
const groups = {
  chip: [
    ['NVDA', 'NVIDIA'], ['AMD', 'Advanced Micro Devices'], ['AVGO', 'Broadcom'], ['TSM', 'Taiwan Semiconductor'],
    ['MU', 'Micron'], ['ARM', 'Arm'], ['MRVL', 'Marvell Technology'], ['ASML', 'ASML'],
    ['AMAT', 'Applied Materials'], ['LRCX', 'Lam Research'], ['KLAC', 'KLA'],
  ],
  cloud: [['MSFT', 'Microsoft'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['ORCL', 'Oracle'], ['META', 'Meta Platforms']],
  infrastructure: [
    ['CRWV', 'CoreWeave'], ['NBIS', 'Nebius Group'], ['SMCI', 'Super Micro Computer'], ['DELL', 'Dell'],
    ['HPE', 'Hewlett Packard Enterprise'], ['ANET', 'Arista Networks'], ['VRT', 'Vertiv'], ['IREN', 'IREN'],
  ],
  application: [
    ['PLTR', 'Palantir'], ['APP', 'AppLovin'], ['CRM', 'Salesforce'], ['ADBE', 'Adobe'], ['NOW', 'ServiceNow'],
    ['SNOW', 'Snowflake'], ['DDOG', 'Datadog'], ['CRWD', 'CrowdStrike'], ['NET', 'Cloudflare'], ['PANW', 'Palo Alto Networks'], ['MDB', 'MongoDB'],
  ],
};

export const AI_CATEGORY_LABELS = Object.freeze({ chip: '芯片与半导体', cloud: '云与大模型平台', infrastructure: '算力基础设施', application: 'AI 应用与软件' });
export const AI_UNIVERSE = Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([category, entries]) => entries.map(([symbol, name]) => [symbol, Object.freeze({ name, category, sector: AI_CATEGORY_LABELS[category] })]))));
export function aiCategoryFor(symbol) { return AI_UNIVERSE[String(symbol || '').toUpperCase()]?.category || null; }
