# Paytm wallet payments and refunds

Versioned support guidance for wallet balance, wallet spends, UPI add-money, and refunds that credit the Paytm wallet. Customer transaction outcomes always come from wallet tools, never from this document alone.

## Wallet balance check

Customers may ask "what is my wallet balance", "kitna balance hai", "wallet frozen", or "wallet limited". Support should retrieve the wallet balance and wallet status from the authoritative wallet system. Explain only the returned balance, currency, and status. Do not invent a balance. Do not promise an unblock if the wallet is frozen or limited; escalate when status is frozen or the customer reports an unexplained freeze.

## Track wallet payments and UPI add-money

Customers may ask to track a wallet payment, a failed wallet spend, duplicate wallet charges, or UPI used to add money into the wallet. Retrieve the payment by transaction id when available. When only amount or date is known, list matching wallet and UPI payments for this customer. Report only the verified status, channel, amount, and counterparty. Do not claim a bank reversal for a wallet-only failure unless a wallet refund record exists.

## Track refunds into the wallet

Customers may say "refund not credited to wallet", "paisa wallet me nahi aaya", or share a refund id for a wallet-bound refund. Look up wallet-destination refunds only. Report the refund status, linked transaction when present, and expected date when the system provides one. Do not tell the customer money is already in the wallet unless the refund status is completed. Bank-bound refunds belong to the generic refund workflow, not the wallet refund path.

## Combined wallet activity

Customers may ask for wallet history, wallet statement, or "track all my wallet payments and refunds". Use the wallet ledger view that combines wallet and UPI payments with wallet-bound refunds for this customer. Summarise recent entries with type, status, and references. Do not mix in another customer's activity. Do not expose internal failure codes beyond a short customer-safe explanation.

## Safety boundary for wallet actions

Support may read wallet balance, payments, and wallet-bound refunds. Support must not invent credits, force a wallet top-up, or reverse a merchant payment that Paytm does not own. Money-adjacent wallet writes require human approval under the autonomy policy. When the wallet system is unavailable, wait or escalate instead of guessing.
