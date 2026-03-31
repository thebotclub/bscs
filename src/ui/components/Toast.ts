import { signal } from '@preact/signals';
import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

let nextId = 1;
export const toasts = signal<ToastItem[]>([]);

export function showToast(message: string, variant: ToastVariant = 'info'): void {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, variant }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}

function ToastItem({ item }: { item: ToastItem }) {
  useEffect(() => {
    // Auto-dismiss already handled in showToast
    return undefined;
  }, []);

  function dismiss() {
    toasts.value = toasts.value.filter((t) => t.id !== item.id);
  }

  return html`
    <div class=${'toast ' + item.variant} onClick=${dismiss}>
      ${item.message}
    </div>
  `;
}

export function ToastContainer() {
  const items = toasts.value;
  if (items.length === 0) return null;
  return html`
    <div class="toast-container">
      ${items.map((item) => html`<${ToastItem} key=${item.id} item=${item} />`)}
    </div>
  `;
}
