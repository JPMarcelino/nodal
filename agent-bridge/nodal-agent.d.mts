/** Types of the helpers the bridge exports (used by the app's tests). */
export interface JsonSchema {
  type?: string;
  enum?: (string | number)[];
  items?: JsonSchema;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}
export function paramSchema(spec: string): JsonSchema;
export function methodSchema(m: { params?: Record<string, string> }): JsonSchema;
export function toolName(method: string): string;
export function toolResult(res: { result?: unknown; error?: { code: string; message: string } }): {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};
