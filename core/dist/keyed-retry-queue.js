export function createKeyedRetryQueue(options) {
    const now = options.now ?? Date.now;
    const pending = new Map();
    const running = new Set();
    const runs = new Map();
    const listeners = new Set();
    let opened = false;
    let stopped = false;
    let timer = null;
    function notify() {
        for (const listener of [...listeners])
            listener();
    }
    function nextDue() {
        let chosen = null;
        let chosenDue = Infinity;
        for (const [key, entry] of pending) {
            if (running.has(key) || entry.dueAt >= chosenDue)
                continue;
            chosen = key;
            chosenDue = entry.dueAt;
        }
        return chosen;
    }
    function schedule() {
        if (!opened || stopped)
            return;
        if (timer !== null)
            clearTimeout(timer);
        timer = null;
        if (running.size >= options.concurrency)
            return;
        const key = nextDue();
        if (key === null)
            return;
        timer = setTimeout(drain, Math.max(0, (pending.get(key)?.dueAt ?? now()) - now()));
        timer.unref?.();
    }
    function drain() {
        timer = null;
        while (!stopped && running.size < options.concurrency) {
            const key = nextDue();
            if (key === null)
                break;
            const entry = pending.get(key);
            if (entry.dueAt > now())
                break;
            pending.delete(key);
            running.add(key);
            void run(key, entry.attempts);
        }
        schedule();
    }
    async function run(key, attempts) {
        try {
            await options.process(key);
        }
        catch (error) {
            options.onError(key, error, attempts + 1);
            pending.set(key, { attempts: attempts + 1, dueAt: now() + options.retryDelayMs(attempts) });
        }
        finally {
            running.delete(key);
            runs.set(key, (runs.get(key) ?? 0) + 1);
            notify();
            schedule();
        }
    }
    function until(condition) {
        const done = () => stopped || condition();
        if (done())
            return Promise.resolve();
        return new Promise((resolve) => {
            const listener = () => {
                if (!done())
                    return;
                listeners.delete(listener);
                resolve();
            };
            listeners.add(listener);
        });
    }
    return {
        enqueue(key) {
            if (stopped || pending.has(key))
                return;
            pending.set(key, { attempts: 0, dueAt: now() });
            schedule();
        },
        open() {
            opened = true;
            schedule();
        },
        stop() {
            stopped = true;
            if (timer !== null)
                clearTimeout(timer);
            timer = null;
            notify();
        },
        settled(keys) {
            return until(() => keys.every((key) => !pending.has(key) && !running.has(key)));
        },
        attempted(keys) {
            const before = new Map(keys.map((key) => [key, runs.get(key) ?? 0]));
            return until(() => keys.every((key) => (runs.get(key) ?? 0) > (before.get(key) ?? 0)));
        },
        pendingCount() {
            return pending.size + running.size;
        },
    };
}
