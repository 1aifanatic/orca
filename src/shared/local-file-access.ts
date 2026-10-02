/**
 * The shape of a desktop file request, which decides what main checks. Absent means the path must
 * be inside a project root main recognises.
 */
export type LocalFileAccess =
  /** A single file the user named (gesture or persisted tab): read in place, regular files only. */
  | { kind: 'user-file' }
  /** A resource a document's content references (images): limited to that document's roots or folder. */
  | { kind: 'document-resource'; documentPath: string }
