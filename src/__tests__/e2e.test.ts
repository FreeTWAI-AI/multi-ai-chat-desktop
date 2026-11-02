import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { runWorkflow, resetWorkflowRuntimeForTests } from '../workflow';
import { host } from '../host';
import { beginSessionCheckpoint, flushSessionCheckpointForTests } from '../workflow/sessionCheckpoint';
import { loadStartupSessionCheckpointNotice } from '../ui/sessionCheckpointStartup';
import App from '../App';
import { I18nProvider } from '../i18n/context';
import { publishBridgeMessage } from '../bridge/bus';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(),
}));

describe('webview session state restore and multi-model dispatch e2e', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetWorkflowRuntimeForTests();
        invokeMock.mockResolvedValue(undefined);
    });

    it('verifies Tauri webview initialization from frontend DOM bindings', () => {
        const html = renderToStaticMarkup(createElement(I18nProvider, { language: 'en', children: createElement(App) }));
        expect(html).toContain('data-provider="chatgpt"');
        expect(html).toContain('data-provider="grok"');
    });

    it('verifies multi-model prompt broadcast across connections via invoke', async () => {
        invokeMock.mockImplementation(async (cmd, args) => {
            if (cmd === 'provider_eval') {
                setTimeout(() => {
                    publishBridgeMessage({ v: 1, action: 'RESPONSE_DONE', provider: args.provider, payload: `${args.provider}-answer`, transport: 'pull' });
                }, 0);
            }
            if (cmd === 'connections_get') {
                return [
                    { provider: 'grok', webview: 'loaded', dom: 'ready', login: 'logged_in' },
                    { provider: 'chatgpt', webview: 'loaded', dom: 'ready', login: 'logged_in' }
                ];
            }
        });

        runWorkflow({ text: 'multi-model prompt test', mode: 'free', targets: ['grok', 'chatgpt'] });
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(invokeMock).toHaveBeenCalledWith('provider_eval', expect.objectContaining({ provider: 'grok' }));
        expect(invokeMock).toHaveBeenCalledWith('provider_eval', expect.objectContaining({ provider: 'chatgpt' }));

        const calls = invokeMock.mock.calls;
        const grokCall = calls.find(call => call[0] === 'provider_eval' && call[1].provider === 'grok');
        expect(grokCall[1].js).toContain('multi-model prompt test');
    });

    it('persists workflow state updates to session checkpoint via invoke', async () => {
        invokeMock.mockImplementation(async (cmd, args) => {
            if (cmd === 'provider_eval') {
                setTimeout(() => {
                    publishBridgeMessage({ v: 1, action: 'RESPONSE_DONE', provider: args.provider, payload: `${args.provider}-answer`, transport: 'pull' });
                }, 0);
            }
            if (cmd === 'connections_get') {
                return [
                    { provider: 'grok', webview: 'loaded', dom: 'ready', login: 'logged_in' },
                    { provider: 'chatgpt', webview: 'loaded', dom: 'ready', login: 'logged_in' }
                ];
            }
        });

        beginSessionCheckpoint({ graphId: 'debate', graphVersion: 1, mode: 'debate', question: 'session persistence test' });

        runWorkflow({ text: 'session persistence test', mode: 'debate', targets: ['grok'] });
        await new Promise(resolve => setTimeout(resolve, 50));
        await flushSessionCheckpointForTests();

        expect(invokeMock).toHaveBeenCalledWith('session_checkpoint_save', expect.any(Object));
        const call = invokeMock.mock.calls.find(c => c[0] === 'session_checkpoint_save');
        expect(call[1].json).toContain('debate');
    });

    it('restores webview session state via Tauri load invoke', async () => {
        invokeMock.mockImplementation(async (cmd) => {
            if (cmd === 'session_checkpoint_load') {
                return '{"graphId":"debate","graphVersion":1,"mode":"debate","stepIndex":2,"questionHash":"abc1234","startedAt":"1","updatedAt":"1"}';
            }
            if (cmd === 'snapshot_list') {
                return [];
            }
            return undefined;
        });

        const notice = await loadStartupSessionCheckpointNotice();

        expect(notice).toBeDefined();
        expect(notice!.checkpoint.graphId).toBe('debate');
        expect(notice!.checkpoint.stepIndex).toBe(2);
        expect(notice!.checkpoint.mode).toBe('debate');
        expect(invokeMock).toHaveBeenCalledWith('session_checkpoint_load');
    });
});
