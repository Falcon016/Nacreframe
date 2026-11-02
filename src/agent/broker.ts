import type { ApprovalRequest, ApprovalResponse, Approver } from './agent.js';
import type { Question } from '../tools/types.js';

export type ApprovalHandler = (req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResponse>;
export type QuestionHandler = (agentId: string, q: Question) => Promise<string>;

/**
 * Funnels approval and question prompts from every agent into one UI, one at a time, in arrival order.
 * With no UI attached (print / rpc without a client) approvals are refused rather than silently granted.
 */
export class Broker {
  approvalHandler: ApprovalHandler | undefined;
  questionHandler: QuestionHandler | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  pending = 0;

  readonly approver: Approver = (req, signal) => {
    this.pending++;
    const run = this.chain.then(async (): Promise<ApprovalResponse> => {
      if (signal.aborted) return { allow: false };
      if (!this.approvalHandler) {
        return {
          allow: false,
          feedback:
            'No interactive approval is available. Ask the user to re-run with --approval auto or add an allow rule.',
        };
      }
      return this.approvalHandler(req, signal);
    });
    const settled = run.finally(() => void this.pending--);
    this.chain = settled.catch(() => undefined);
    return settled;
  };

  ask(agentId: string, q: Question): Promise<string> {
    if (!this.questionHandler) return Promise.resolve('(no interactive user available)');
    const run = this.chain.then(() => this.questionHandler!(agentId, q));
    this.chain = run.catch(() => undefined);
    return run;
  }
}
