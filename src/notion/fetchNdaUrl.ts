import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export async function fetchNdaUrl(notion_page_id: string): Promise<string | undefined> {
  // The NDA URL lives on the page; adapt if it's a DB property
  const page = await notion.pages.retrieve({ page_id: notion_page_id });
  // @ts-ignore – quick access; map to your exact schema
  const props = (page as any).properties ?? {};
  const ndaProp = props['NDA URL'] ?? props['NDA'] ?? props['Confidentiality Link'];
  if (!ndaProp) return undefined;

  // handle "url" type or "rich_text"
  const url = ndaProp?.url ?? ndaProp?.rich_text?.[0]?.href ?? ndaProp?.rich_text?.[0]?.plain_text;
  return url;
}

