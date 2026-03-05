import { useEffect, useState } from 'react';

export interface EventToastData {
  id: string;
  title: string;
  content: React.ReactNode;
  type: 'death' | 'vote' | 'peace' | 'info' | 'mark';
}

interface Props {
  events: EventToastData[];
  onDismiss: (id: string) => void;
}

export default function EventToast({ events, onDismiss }: Props) {
  if (events.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 space-y-3">
        {events.map(ev => (
          <ToastCard key={ev.id} event={ev} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}

function ToastCard({ event, onDismiss }: { event: EventToastData; onDismiss: (id: string) => void }) {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    const duration = 5000;
    const interval = 50;
    const step = (interval / duration) * 100;
    const timer = setInterval(() => {
      setProgress(prev => {
        if (prev <= 0) {
          clearInterval(timer);
          onDismiss(event.id);
          return 0;
        }
        return prev - step;
      });
    }, interval);

    return () => clearInterval(timer);
  }, [event.id, onDismiss]);

  const borderColor = {
    death: 'border-red-500',
    vote: 'border-orange-500',
    peace: 'border-green-500',
    info: 'border-blue-500',
    mark: 'border-indigo-500',
  }[event.type];

  const titleColor = {
    death: 'text-red-400',
    vote: 'text-orange-400',
    peace: 'text-green-400',
    info: 'text-blue-400',
    mark: 'text-indigo-400',
  }[event.type];

  const barColor = {
    death: 'bg-red-500',
    vote: 'bg-orange-500',
    peace: 'bg-green-500',
    info: 'bg-blue-500',
    mark: 'bg-indigo-500',
  }[event.type];

  return (
    <div
      className={`bg-gray-900 border-l-4 ${borderColor} rounded-lg p-4 shadow-2xl cursor-pointer animate-slide-in`}
      onClick={() => onDismiss(event.id)}
    >
      <div className="flex items-center justify-between mb-2">
        <h4 className={`font-bold ${titleColor}`}>{event.title}</h4>
        <span className="text-gray-600 text-xs">点击关闭</span>
      </div>
      <div className="text-gray-300 text-sm">{event.content}</div>
      <div className="mt-3 h-0.5 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-50 ease-linear`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
