/**
 * Client half: a compact Antigravity quota chip inside the composer tool row.
 *
 * It reads the cached summary from the host route `/antigravity/quota`, shows
 * the used percentage of the 5-hour and weekly windows for the group that owns
 * the current model, and lists every group in the hover tooltip.
 */
window.__ModuleLoader__.load({
  id: 'dsh-antigravity',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'antigravity-quota';
    const POLL_MS = 60_000;

    const DICTS = {
      en: {
        short: 'Antigravity',
        title: 'Antigravity subscription quota',
        fiveHour: '5h {pct}%',
        weekly: 'wk {pct}%',
        fiveHourDetail: '5-hour window: used {pct}%, resets {reset}',
        weeklyDetail: 'Weekly window: used {pct}%, resets {reset}',
        refresh: 'Click to refresh',
        unavailable: 'Antigravity quota unavailable: {message}',
        loading: 'Loading Antigravity quota…',
      },
      ru: {
        short: 'Antigravity',
        title: 'Квота подписки Antigravity',
        fiveHour: '5ч {pct}%',
        weekly: 'нед {pct}%',
        fiveHourDetail: '5-часовое окно: использовано {pct}%, сброс {reset}',
        weeklyDetail: 'Недельное окно: использовано {pct}%, сброс {reset}',
        refresh: 'Нажмите, чтобы обновить',
        unavailable: 'Квота Antigravity недоступна: {message}',
        loading: 'Загрузка квоты Antigravity…',
      },
    };

    let localeService;
    let translate = (key, params) => interpolate(DICTS.en[key] ?? key, params);
    let revision = 0;
    const listeners = new Set();
    const store = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot() {
        return revision;
      },
    };
    function publish() {
      revision += 1;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A broken subscriber must not break the locale update.
        }
      }
    }

    function interpolate(template, params) {
      if (typeof template !== 'string') return '';
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    function tr(key, params) {
      try {
        if (localeService !== undefined) return localeService.bind(NS)(key, params);
      } catch {
        // Fall back to the built-in dictionary.
      }
      return interpolate(DICTS.en[key] ?? key, params);
    }

    async function fetchQuota(force) {
      const url = `/antigravity/quota${force ? '?refresh=1' : ''}`;
      let token;
      try {
        token = globalThis.__DSH_ANTIGRAVITY_QUOTA__?.token;
      } catch {
        token = undefined;
      }
      const headers = { accept: 'application/json' };
      if (typeof token === 'string' && token !== '') headers['x-antigravity-quota'] = token;
      const response = await fetch(url, { headers, cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new Error(body?.error?.message ?? 'quota unavailable');
      }
      return body.data;
    }

    function findBucket(group, window) {
      for (const bucket of group?.buckets ?? []) {
        if (bucket.window === window) return bucket;
      }
      return undefined;
    }

    function formatPercent(fraction) {
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined;
      const percent = Math.max(0, Math.min(100, fraction * 100));
      if (percent >= 99.95) return '100';
      if (percent > 0 && percent < 0.1) return '<0.1';
      return String(percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10);
    }

    function formatReset(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      try {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function chooseGroup(data, selection) {
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      if (groups.length === 0) return undefined;
      const model = typeof selection?.model === 'string' ? selection.model : '';
      const provider = typeof selection?.provider === 'string' ? selection.provider : '';
      if (provider === 'antigravity') {
        const thirdParty = /^(claude|gpt)/i.test(model);
        const wanted = thirdParty ? /claude|gpt|3p/i : /gemini/i;
        const matched = groups.find((group) => wanted.test(group.name) || group.buckets.some((bucket) => wanted.test(bucket.id)));
        if (matched !== undefined) return matched;
      }
      let best = groups[0];
      let bestUsed = -1;
      for (const group of groups) {
        const used = findBucket(group, '5h')?.usedFraction ?? 0;
        if (used > bestUsed) {
          bestUsed = used;
          best = group;
        }
      }
      return best;
    }

    function toneColor(used) {
      if (typeof used !== 'number' || !Number.isFinite(used)) return 'var(--dsw-alias-state-idle-primary)';
      if (used >= 0.8) return 'var(--dsw-alias-state-error-primary)';
      if (used >= 0.5) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-state-success-primary)';
    }

    function tooltipText(data, group) {
      const lines = [tr('title') + (typeof data?.account === 'string' && data.account !== '' ? ` · ${data.account}` : '')];
      for (const entry of data?.groups ?? []) {
        const five = findBucket(entry, '5h');
        const week = findBucket(entry, 'weekly');
        const parts = [];
        if (five !== undefined) parts.push(tr('fiveHourDetail', { pct: formatPercent(five.usedFraction) ?? '—', reset: formatReset(five.resetTime) || '—' }));
        if (week !== undefined) parts.push(tr('weeklyDetail', { pct: formatPercent(week.usedFraction) ?? '—', reset: formatReset(week.resetTime) || '—' }));
        if (parts.length > 0) lines.push(`${entry.name} — ${parts.join('; ')}`);
      }
      if (group !== undefined && (data?.groups ?? []).length > 1) {
        // The chip itself follows the group of the selected model; the tooltip lists all.
        lines.push(`(${group.name})`);
      }
      lines.push(tr('refresh'));
      return lines.join('\n');
    }

    const pillStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 9px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
      lineHeight: '1',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      userSelect: 'none',
      flex: '0 0 auto',
    };
    const dotStyle = (color) => ({ width: '6px', height: '6px', borderRadius: '50%', background: color, flex: '0 0 auto' });

    function QuotaChip(props) {
      React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const useProjection = props?.useProjection;
      let selection;
      try {
        selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
      } catch {
        selection = undefined;
      }
      const [state, setState] = React.useState({ status: 'loading', data: undefined, error: undefined });
      const active = React.useRef(true);

      const refresh = React.useCallback(async (force) => {
        try {
          const data = await fetchQuota(force);
          if (active.current) setState({ status: 'ready', data, error: undefined });
        } catch (error) {
          if (active.current) {
            setState((previous) => ({ status: previous.data === undefined ? 'error' : 'stale', data: previous.data, error: error?.message ?? String(error) }));
          }
        }
      }, []);

      React.useEffect(() => {
        active.current = true;
        refresh(false);
        const timer = setInterval(() => refresh(false), POLL_MS);
        const onVisibility = () => {
          if (document.visibilityState === 'visible') refresh(false);
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          active.current = false;
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [refresh]);

      const data = state.data;
      const group = data === undefined ? undefined : chooseGroup(data, selection?.next ?? selection?.lastUsed);
      const five = findBucket(group, '5h');
      const week = findBucket(group, 'weekly');
      const fiveUsed = five?.usedFraction;
      const weekUsed = week?.usedFraction;
      const worst = Math.max(typeof fiveUsed === 'number' ? fiveUsed : 0, typeof weekUsed === 'number' ? weekUsed : 0);
      const tooltip = data === undefined
        ? state.error === undefined ? tr('loading') : tr('unavailable', { message: state.error })
        : tooltipText(data, group);
      const label = tr('short');
      const fiveText = five === undefined ? '—' : tr('fiveHour', { pct: formatPercent(fiveUsed) ?? '—' });
      const weekText = week === undefined ? '—' : tr('weekly', { pct: formatPercent(weekUsed) ?? '—' });

      return h(
        'button',
        {
          type: 'button',
          title: tooltip,
          'aria-label': tooltip,
          style: pillStyle,
          onClick: () => {
            setState((previous) => ({ status: 'loading', data: previous.data, error: undefined }));
            refresh(true);
          },
        },
        h('span', { style: dotStyle(toneColor(worst)), 'aria-hidden': true }),
        h('span', null, label),
        h('span', null, '·'),
        h('span', null, fiveText),
        h('span', null, '·'),
        h('span', null, weekText),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const locale = ctx.get('locale');
          if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
            localeService = locale;
            const disposeRegister = locale.register(NS, { en: DICTS.en, ru: DICTS.ru });
            const disposeSubscribe = typeof locale.subscribe === 'function' ? locale.subscribe(publish) : undefined;
            ctx.effect(() => () => {
              try {
                if (disposeSubscribe !== undefined) disposeSubscribe();
              } finally {
                if (typeof disposeRegister === 'function') disposeRegister();
              }
            });
          }
        } catch (error) {
          console.warn('antigravity quota: locale registration failed', error);
        }
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'antigravity-quota', order: 10 },
          QuotaChip,
        ));
      },
    };
  },
});
