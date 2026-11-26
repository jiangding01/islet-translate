// Small stroke icons shared by the settings lists and dialogs. Decorative: the buttons that
// hold them carry the label.

export function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M9.5 2.5l2 2L5 11H3V9z" />
    </svg>
  );
}

export function DeleteIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.6 7.5h4.8L10 4" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

export function ImportIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 8V1.8M3.4 4.3L6 1.8l2.6 2.5M2 9.5v1h8v-1" />
    </svg>
  );
}

export function ExportIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 1.8V8M3.4 5.5L6 8l2.6-2.5M2 9.5v1h8v-1" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="6" cy="6" r="4.2" />
      <path d="M9.2 9.2l3 3" />
    </svg>
  );
}

/** A document; `upload` adds the arrow of the drop area. */
export function FileIcon({ size, upload }: { size: number; upload?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={upload ? 1.1 : 1.2}
    >
      <path d="M4 1.8h5.2L12 4.6v9.6H4z" />
      <path d={upload ? 'M9 1.8v3h3M6 8.5l2-2 2 2M8 6.6v4.6' : 'M9 1.8v3h3'} />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 4v3.6M7 9.6v.1" />
    </svg>
  );
}
