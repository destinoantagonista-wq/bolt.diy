import { memo, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentEventAnnotation } from '~/types/context';
import { classNames } from '~/utils/classNames';

interface AgentRealtimeFeedProps {
  events?: AgentEventAnnotation[];
  isStreaming?: boolean;
}

const LEVEL_ICON: Record<AgentEventAnnotation['level'], string> = {
  info: 'i-ph:activity',
  warning: 'i-ph:warning-circle',
  error: 'i-ph:x-circle',
};

const LEVEL_STYLE: Record<AgentEventAnnotation['level'], string> = {
  info: 'text-bolt-elements-textSecondary',
  warning: 'text-amber-500',
  error: 'text-red-500',
};

function AgentRealtimeFeedComponent({ events = [], isStreaming = false }: AgentRealtimeFeedProps) {
  const timeline = useMemo(() => {
    const uniqueById = new Map<string, AgentEventAnnotation>();

    for (const event of events) {
      uniqueById.set(event.id, event);
    }

    return Array.from(uniqueById.values())
      .sort((a, b) => a.order - b.order)
      .slice(-8);
  }, [events]);

  if (!isStreaming && timeline.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-bolt-elements-textSecondary">
        <div className={classNames('i-ph:pulse')} />
        <span>Agent realtime status</span>
      </div>

      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-1 text-xs">
        <AnimatePresence initial={false}>
          {timeline.map((event) => {
            return (
              <motion.div
                key={event.id}
                className="flex items-start gap-2 rounded bg-bolt-elements-background-depth-3 px-2 py-1.5"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.12 }}
              >
                <div className={classNames('mt-[2px] text-sm', LEVEL_ICON[event.level], LEVEL_STYLE[event.level])} />
                <div className="min-w-0 flex-1">
                  <div className="break-words text-bolt-elements-textPrimary">{event.message}</div>
                  {event.stage && <div className="text-[10px] text-bolt-elements-textTertiary">{event.stage}</div>}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

export const AgentRealtimeFeed = memo(AgentRealtimeFeedComponent);
