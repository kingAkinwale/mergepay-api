import { prisma } from "../db";
import {
  computeNetBalances,
  suggestSettlements,
  type BalanceShareRow,
  type BalanceSettlementRow,
  type NetBalance,
} from "./settlement";
import { getAssetConfig } from "./assets";
import { toStroops } from "./money";
import { Errors } from "../errors";
import { Prisma } from "@prisma/client";

/**
 * The asset a group settles in: derived from its expenses, default XLM.
 * Uses the centralized asset configuration to ensure the returned code+issuer
 * pair is valid.
 */
export async function groupPrimaryAsset(
  groupId: string
): Promise<{ assetCode: string; assetIssuer: string | null }> {
  const latest = await prisma.expense.findFirst({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    select: { assetCode: true, assetIssuer: true },
  });
  const code = latest?.assetCode ?? "XLM";
  const issuer = latest?.assetIssuer ?? null;
  // Validate via the central registry (throws if misconfigured at startup).
  const asset = getAssetConfig(code, issuer ?? undefined);
  return {
    assetCode: asset.code,
    assetIssuer: asset.issuer,
  };
}

/** Load the rows the settlement engine needs and compute net balances. */
export async function loadGroupBalances(groupId: string): Promise<NetBalance[]> {
  const [expenses, settlements] = await Promise.all([
    prisma.expense.findMany({
      where: { groupId },
      include: { shares: true },
    }),
    prisma.settlement.findMany({ where: { groupId } }),
  ]);

  const shareRows: BalanceShareRow[] = [];
  for (const e of expenses) {
    for (const s of e.shares) {
      shareRows.push({
        payerUserId: e.payerUserId,
        userId: s.userId,
        shareAmount: s.shareAmount.toString(),
        settled: s.status === "settled",
      });
    }
  }

  const settlementRows: BalanceSettlementRow[] = settlements.map((s) => ({
    fromUserId: s.fromUserId,
    toUserId: s.toUserId,
    amount: s.amount.toString(),
    confirmed: s.status === "confirmed",
  }));

  return computeNetBalances(shareRows, settlementRows);
}

export async function loadGroupBalancesWithSuggestions(groupId: string) {
  const balances = await loadGroupBalances(groupId);
  const suggestions = suggestSettlements(balances);
  return { balances, suggestions };
}

/** A single user's net in a group (used for group summaries). */
export async function userNetInGroup(
  groupId: string,
  userId: string
): Promise<string> {
  const balances = await loadGroupBalances(groupId);
  return balances.find((b) => b.userId === userId)?.net ?? "0";
}

/**
 * Verify that the settlement amount does not exceed the remaining unpaid debt
 * between the payer and receiver. Used during settlement creation to prevent
 * over-settlement.
 */
export async function verifySettlementLimit(
  tx: Prisma.TransactionClient,
  groupId: string,
  fromUserId: string,
  toUserId: string,
  settlementAmount: string
): Promise<void> {
  const [expenses, settlements] = await Promise.all([
    tx.expense.findMany({
      where: { groupId },
      include: { shares: { where: { OR: [{ userId: fromUserId }, { userId: toUserId }] } } },
    }),
    tx.settlement.findMany({
      where: {
        groupId,
        status: { not: "failed" }, // Pending and submitted settlements reduce the available limit
        OR: [
          { fromUserId, toUserId },
          { fromUserId: toUserId, toUserId: fromUserId },
        ],
      },
    }),
  ]);

  let debtStroops = 0n;

  for (const e of expenses) {
    for (const s of e.shares) {
      if (s.status === "settled") continue;
      if (e.payerUserId === toUserId && s.userId === fromUserId) {
        debtStroops += toStroops(s.shareAmount.toString());
      } else if (e.payerUserId === fromUserId && s.userId === toUserId) {
        debtStroops -= toStroops(s.shareAmount.toString());
      }
    }
  }

  for (const s of settlements) {
    if (s.fromUserId === fromUserId && s.toUserId === toUserId) {
      debtStroops -= toStroops(s.amount.toString());
    } else if (s.fromUserId === toUserId && s.toUserId === fromUserId) {
      debtStroops += toStroops(s.amount.toString());
    }
  }

  if (toStroops(settlementAmount) > debtStroops) {
    throw Errors.badRequest("OVER_SETTLEMENT", "Settlement amount exceeds outstanding debt balance");
  }
}
