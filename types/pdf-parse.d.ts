/**
 * pdf-parse ships no types. One declaration is cheaper than a dependency on
 * @types, and it documents the only two things this project uses.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  type TextItem = { str: string; transform?: number[]; width?: number; height?: number };
  type PageProxy = { getTextContent: () => Promise<{ items: TextItem[] }> };
  type Options = { pagerender?: (page: PageProxy) => Promise<string> };
  function pdf(data: Buffer, options?: Options): Promise<{ text: string; numpages: number }>;
  export default pdf;
}
