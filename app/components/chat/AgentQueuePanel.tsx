import { useMemo, useState } from 'react';
import type { AgentQueueItem } from '~/types/agent-queue';
import { classNames } from '~/utils/classNames';

interface AgentQueuePanelProps {
  chatMode?: 'discuss' | 'build' | 'agent';
  queue: AgentQueueItem[];
  activeItem: AgentQueueItem | null;
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onEdit: (id: string, prompt: string) => void;
  onCopy: (id: string) => void;
  onRemove: (id: string) => void;
  onRepeat: (id: string, count: number) => void;
}

export function AgentQueuePanel(props: AgentQueuePanelProps) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState('');
  const [repeatCountById, setRepeatCountById] = useState<Record<string, number>>({});

  const totalPending = props.queue.length;
  const statusLabel = useMemo(() => {
    if (props.activeItem && props.paused) {
      return 'Running (queue paused)';
    }

    if (props.activeItem) {
      return 'Running';
    }

    if (props.paused && totalPending > 0) {
      return 'Paused';
    }

    return totalPending > 0 ? 'Idle (ready)' : 'Empty';
  }, [props.activeItem, props.paused, totalPending]);

  if (props.chatMode !== 'agent') {
    return null;
  }

  if (!props.activeItem && props.queue.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-bolt-elements-textSecondary">
          <div className="i-ph:list-bullets text-base" />
          <span className="font-medium text-bolt-elements-textPrimary">Agent queue</span>
          <span className="rounded bg-bolt-elements-item-backgroundDefault px-1.5 py-0.5">pending: {totalPending}</span>
          <span className="rounded bg-bolt-elements-item-backgroundDefault px-1.5 py-0.5">status: {statusLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={classNames(
              'rounded px-2 py-1 text-xs transition-all',
              props.paused
                ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
                : 'bg-bolt-elements-item-backgroundDefault text-bolt-elements-item-contentDefault',
            )}
            onClick={props.onTogglePause}
            type="button"
          >
            {props.paused ? 'Resume' : 'Pause'}
          </button>
          <button
            className="rounded bg-bolt-elements-item-backgroundDefault px-2 py-1 text-xs text-bolt-elements-item-contentDefault transition-all disabled:opacity-50"
            disabled={props.queue.length === 0}
            onClick={props.onClear}
            type="button"
          >
            Clear
          </button>
        </div>
      </div>

      {props.activeItem && (
        <div className="mt-2 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 p-2">
          <div className="mb-1 flex items-center gap-2 text-xs text-bolt-elements-textSecondary">
            <div className="i-svg-spinners:3-dots-fade text-base" />
            <span>Active task</span>
          </div>
          <p className="line-clamp-3 text-sm text-bolt-elements-textPrimary">{props.activeItem.prompt}</p>
        </div>
      )}

      {props.queue.length > 0 && (
        <div className="mt-2 flex max-h-60 flex-col gap-2 overflow-y-auto pr-1">
          {props.queue.map((item, index) => {
            const isEditing = editingItemId === item.id;
            const repeatCount = repeatCountById[item.id] ?? 1;

            return (
              <div
                key={item.id}
                className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 p-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-bolt-elements-textSecondary">#{index + 1}</span>
                  <div className="flex items-center gap-1">
                    <button
                      className="rounded bg-bolt-elements-item-backgroundDefault px-1.5 py-0.5 text-xs text-bolt-elements-item-contentDefault disabled:opacity-40"
                      disabled={index === 0}
                      onClick={() => props.onMove(item.id, 'up')}
                      type="button"
                    >
                      Up
                    </button>
                    <button
                      className="rounded bg-bolt-elements-item-backgroundDefault px-1.5 py-0.5 text-xs text-bolt-elements-item-contentDefault disabled:opacity-40"
                      disabled={index === props.queue.length - 1}
                      onClick={() => props.onMove(item.id, 'down')}
                      type="button"
                    >
                      Down
                    </button>
                  </div>
                </div>

                {isEditing ? (
                  <textarea
                    className="w-full resize-y rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2 text-sm text-bolt-elements-textPrimary"
                    rows={3}
                    value={editingPrompt}
                    onChange={(event) => setEditingPrompt(event.target.value)}
                  />
                ) : (
                  <p className="line-clamp-3 text-sm text-bolt-elements-textPrimary">{item.prompt}</p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {isEditing ? (
                    <>
                      <button
                        className="rounded bg-bolt-elements-item-backgroundAccent px-2 py-1 text-xs text-bolt-elements-item-contentAccent"
                        onClick={() => {
                          props.onEdit(item.id, editingPrompt);
                          setEditingItemId(null);
                          setEditingPrompt('');
                        }}
                        type="button"
                      >
                        Save
                      </button>
                      <button
                        className="rounded bg-bolt-elements-item-backgroundDefault px-2 py-1 text-xs text-bolt-elements-item-contentDefault"
                        onClick={() => {
                          setEditingItemId(null);
                          setEditingPrompt('');
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="rounded bg-bolt-elements-item-backgroundDefault px-2 py-1 text-xs text-bolt-elements-item-contentDefault"
                      onClick={() => {
                        setEditingItemId(item.id);
                        setEditingPrompt(item.prompt);
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                  )}

                  <button
                    className="rounded bg-bolt-elements-item-backgroundDefault px-2 py-1 text-xs text-bolt-elements-item-contentDefault"
                    onClick={() => props.onCopy(item.id)}
                    type="button"
                  >
                    Copy
                  </button>
                  <button
                    className="rounded bg-bolt-elements-item-backgroundDefault px-2 py-1 text-xs text-bolt-elements-item-contentDefault"
                    onClick={() => props.onRemove(item.id)}
                    type="button"
                  >
                    Remove
                  </button>
                  <input
                    className="w-14 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1.5 py-1 text-xs text-bolt-elements-textPrimary"
                    max={50}
                    min={1}
                    type="number"
                    value={repeatCount}
                    onChange={(event) => {
                      const numeric = Number(event.target.value);
                      const safeValue = Number.isFinite(numeric) ? Math.min(50, Math.max(1, numeric)) : 1;
                      setRepeatCountById((prev) => ({ ...prev, [item.id]: safeValue }));
                    }}
                  />
                  <button
                    className="rounded bg-bolt-elements-item-backgroundDefault px-2 py-1 text-xs text-bolt-elements-item-contentDefault"
                    onClick={() => props.onRepeat(item.id, repeatCount)}
                    type="button"
                  >
                    Repeat
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
