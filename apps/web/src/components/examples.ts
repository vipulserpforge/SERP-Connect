/** Sample conversations shown on the marketing pages. Clearly labelled as sample data wherever they appear. */
export interface Example {
  id: string;
  label: string;
  question: string;
  tool: string;
  summary: string;
  columns: string[];
  rows: string[][];
}

export const EXAMPLES: Example[] = [
  {
    id: "gains",
    label: "Pages gaining clicks",
    question: "Which pages gained the most clicks in the last 28 days compared with the 28 before?",
    tool: "query_gsc_performance",
    summary: "Clicks are up 12% overall (18,420 vs 16,450). Four pages account for most of the gain.",
    columns: ["Page", "Clicks", "Change"],
    rows: [
      ["/blog/technical-seo-audit", "1,284", "+38%"],
      ["/guides/core-web-vitals", "962", "+21%"],
      ["/blog/schema-markup-examples", "640", "+17%"],
      ["/tools/keyword-gap", "311", "+9%"],
    ],
  },
  {
    id: "organic",
    label: "Organic landing pages",
    question: "Which landing pages got the most organic users last week?",
    tool: "query_ga4_report",
    summary: "Organic Search sent 6,930 active users. The top three landing pages bring 61% of them.",
    columns: ["Landing page", "Organic users", "Key events"],
    rows: [
      ["/blog/technical-seo-audit", "2,140", "96"],
      ["/guides/core-web-vitals", "1,310", "54"],
      ["/pricing", "780", "121"],
      ["/blog/schema-markup-examples", "655", "23"],
    ],
  },
  {
    id: "ctr",
    label: "Low-CTR queries",
    question: "Which queries get lots of impressions but few clicks?",
    tool: "query_gsc_performance",
    summary: "Five queries rank on page one but earn under 2% CTR. Better titles are the quickest win.",
    columns: ["Query", "Impressions", "CTR", "Position"],
    rows: [
      ["seo audit checklist", "48,200", "1.4%", "4.1"],
      ["core web vitals test", "31,900", "1.8%", "5.6"],
      ["what is schema markup", "22,750", "1.1%", "3.8"],
      ["keyword gap analysis", "14,300", "1.9%", "6.2"],
    ],
  },
];
