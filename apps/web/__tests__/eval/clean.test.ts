import { afterAll, describe, expect, test } from "vitest";
import { env } from "@/env";
import { getEmail } from "@/__tests__/helpers";
import {
  describeEvalMatrix,
  shouldRunEvalTests,
} from "@/__tests__/eval/models";
import { createEvalReporter } from "@/__tests__/eval/reporter";
import { aiClean, jevClean } from "@/utils/ai/clean/ai-clean";
import { createScopedLogger } from "@/utils/logger";

// pnpm test-ai eval/clean
// Multi-model: EVAL_MODELS=all pnpm test-ai eval/clean
// Jev/Kev: JEV_ENABLED=true JEV_BASE_URL=... pnpm test-ai eval/clean -t jev

const shouldRunEval = shouldRunEvalTests();
const TIMEOUT = 60_000;
const logger = createScopedLogger("eval-clean");

const DEFAULT_SKIPS = { reply: true, receipt: false };
const KEEP_RECEIPTS = { reply: true, receipt: true };

// These are the emails the controller's static checks (starred, sent,
// unsubscribe links, newsletter senders, Gmail category tabs) leave for AI.
// Every person, company and domain is made up.
const cases: {
  name: string;
  archive: boolean;
  skips: { reply: boolean; receipt: boolean };
  email: ReturnType<typeof getEmail>;
}[] = [
  // --- Archive: automated and low-priority ---
  {
    name: "old CI build passed notification",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "builds@ci-runner.example",
      subject: "Build #4821 passed on main",
      content:
        "All 312 checks passed for commit 8f3a2c1 on main. Duration: 6m 41s.",
      date: daysAgo(40),
    }),
  },
  {
    name: "shipping update for a delivered order",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "tracking@parcelgo.example",
      subject: "Your package was delivered",
      content:
        "Your package with tracking number PG29481 was delivered on Tuesday at 2:14 PM and left at the front door.",
      date: daysAgo(21),
    }),
  },
  {
    name: "new device sign-in alert from last month",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "security@cloudnotes.example",
      subject: "New sign-in to your account",
      content:
        "We noticed a new sign-in from Chrome on macOS in Denver, CO. If this was you, no action is needed.",
      date: daysAgo(35),
    }),
  },
  {
    name: "social reaction notification",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "notify@connectly.example",
      subject: "Priya and 4 others reacted to your post",
      content:
        "Priya Shah and 4 others reacted to your post about hiring backend engineers.",
      date: daysAgo(12),
    }),
  },
  {
    name: "calendar reminder for a past meeting",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "calendar@schedulely.example",
      subject: "Reminder: Quarterly planning at 10:00",
      content:
        "This is a reminder that Quarterly planning starts at 10:00 in the Maple room.",
      date: daysAgo(60),
    }),
  },
  {
    name: "password changed confirmation",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "no-reply@taskboard.example",
      subject: "Your password was changed",
      content:
        "The password for your Taskboard account was changed. If you made this change, you can ignore this email.",
      date: daysAgo(90),
    }),
  },
  {
    name: "webinar recording is available",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "events@datapulse.example",
      subject: "The recording of 'Scaling Postgres' is ready",
      content:
        "Thanks for registering. The recording and slides from last week's session are now available on demand.",
      date: daysAgo(18),
    }),
  },
  {
    name: "old issue comment notification",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "notifications@codehost.example",
      subject: "Re: [acme/api] Timeout on large exports (#882)",
      content:
        "@dmorales commented: I can reproduce this on v2.3. Closing in favour of #901.",
      date: daysAgo(75),
    }),
  },
  {
    name: "resolved support ticket survey",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "support@helpdesk.example",
      subject: "How did we do? Ticket #55120",
      content:
        "Your ticket 'Cannot export invoices' was marked resolved. Rate your experience with one click.",
      date: daysAgo(30),
    }),
  },
  {
    name: "payment reminder when receipts are kept",
    archive: true,
    skips: KEEP_RECEIPTS,
    email: getEmail({
      from: "billing@hostfleet.example",
      subject: "Your subscription renews in 7 days",
      content:
        "Your Pro plan renews on March 3 for $29. No action is needed if you'd like to continue.",
      date: daysAgo(45),
    }),
  },
  {
    name: "receipt when receipts are not kept",
    archive: true,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "receipts@coffeeco.example",
      subject: "Your receipt from Coffee Co",
      content: "Thanks for your order. Oat latte $5.40. Paid with Visa 4242.",
      date: daysAgo(50),
    }),
  },

  // --- Keep: needs a reply or matters ---
  {
    name: "client asking a direct question",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Hannah Brooks <hannah@brooksdesign.example>",
      subject: "Contract start date",
      content:
        "Hi, could you confirm whether we can move the contract start to April 1? I need to tell my team by Friday.",
      date: daysAgo(2),
    }),
  },
  {
    name: "manager requesting a deliverable",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Luis Ortega <luis@ourcompany.example>",
      subject: "Board deck numbers",
      content:
        "Can you send me the Q1 revenue breakdown by region before Thursday's board meeting?",
      date: daysAgo(1),
    }),
  },
  {
    name: "friend making plans",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Sam Lee <sam.lee@mailbox.example>",
      subject: "Dinner next week?",
      content: "Are you free Tuesday or Wednesday for dinner? Let me know!",
      date: daysAgo(3),
    }),
  },
  {
    name: "recruiter reply to the user's application",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Maria Chen <maria@talentbridge.example>",
      subject: "Re: Senior engineer role",
      content:
        "Thanks for applying. Would you be available for a 30 minute call on Monday or Tuesday afternoon?",
      date: daysAgo(4),
    }),
  },
  {
    name: "landlord needing a signature",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Oak Street Properties <leasing@oakstreet.example>",
      subject: "Lease renewal - signature needed",
      content:
        "Your lease ends next month. Please review and sign the attached renewal by the 25th so we can hold your unit.",
      date: daysAgo(5),
    }),
  },
  {
    name: "account suspension warning needing action",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "billing@hostfleet.example",
      subject: "Action required: payment failed",
      content:
        "We couldn't charge your card for your server plan. Update your payment method within 3 days to avoid suspension of your production servers.",
      date: daysAgo(1),
    }),
  },
  {
    name: "invoice when receipts are kept",
    archive: false,
    skips: KEEP_RECEIPTS,
    email: getEmail({
      from: "accounts@studiorent.example",
      subject: "Invoice INV-2291 paid",
      content:
        "Payment received for invoice INV-2291: studio rental, March. Amount: $1,200.00. Thank you.",
      date: daysAgo(40),
    }),
  },
  {
    name: "purchase receipt when receipts are kept",
    archive: false,
    skips: KEEP_RECEIPTS,
    email: getEmail({
      from: "orders@laptopworks.example",
      subject: "Order confirmation #LW-77812",
      content:
        "Thanks for your purchase. 14-inch laptop, 32GB RAM: $1,899.00. Paid with Mastercard ending 1180.",
      date: daysAgo(20),
    }),
  },
  {
    name: "colleague handing over a task",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Aisha Khan <aisha@ourcompany.example>",
      subject: "Handover while I'm on leave",
      content:
        "I'm out from Monday. Could you take over the vendor renewal? The contract and pricing notes are in the shared folder. Let me know if you have questions.",
      date: daysAgo(2),
    }),
  },
  {
    name: "doctor's office asking to reschedule",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Riverside Clinic <appointments@riversideclinic.example>",
      subject: "Please reschedule your appointment",
      content:
        "Dr. Patel is unavailable on the 14th. Please reply with a time that works for you next week.",
      date: daysAgo(1),
    }),
  },
  {
    name: "investor follow-up",
    archive: false,
    skips: DEFAULT_SKIPS,
    email: getEmail({
      from: "Ethan Cole <ethan@northfieldvc.example>",
      subject: "Following up on our call",
      content:
        "Great speaking yesterday. Could you share your latest metrics and the data room link? We'd like to move to a partner meeting.",
      date: daysAgo(2),
    }),
  },
];

describe.runIf(shouldRunEval)("Eval: Inbox Clean", () => {
  const evalReporter = createEvalReporter({ evalName: "clean" });

  describeEvalMatrix("clean", (model, emailAccount) => {
    for (const tc of cases) {
      const testName = `${tc.name} → ${tc.archive ? "archive" : "keep"}`;
      test(
        testName,
        async () => {
          const result = await aiClean({
            emailAccount,
            messageId: tc.email.id,
            messages: [tc.email],
            skips: tc.skips,
          });

          evalReporter.record({
            testName,
            model: model.label,
            pass: result.archive === tc.archive,
            expected: String(tc.archive),
            actual: String(result.archive),
          });

          expect(result.archive).toBe(tc.archive);
        },
        TIMEOUT,
      );
    }
  });

  // When Jev answers it must be right; falling back to the LLM is always safe.
  describe.runIf(env.JEV_ENABLED)("jev", () => {
    for (const tc of cases) {
      const testName = `jev: ${tc.name} → ${tc.archive ? "archive" : "keep"}`;
      test(
        testName,
        async () => {
          const start = performance.now();
          const result = await jevClean({
            messages: [tc.email],
            skips: tc.skips,
            logger,
          });
          const ms = Math.round(performance.now() - start);

          const pass = !result || result.archive === tc.archive;
          evalReporter.record({
            testName,
            model: "jev",
            pass,
            expected: String(tc.archive),
            actual: `${result ? `${result.archive} (${result.reason})` : "fallback"} ${ms}ms`,
          });

          expect(pass).toBe(true);
        },
        TIMEOUT,
      );
    }
  });

  afterAll(() => {
    evalReporter.printReport();
  });
});

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
