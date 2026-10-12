# Go-live checklist

The bot refuses to start in live mode unless EVERY box below is ticked (`- [x]`)
and the sign-off at the bottom is filled in with a date from the last 30 days.

Only the owner edits this file (Claude needs explicit approval, and Claude never
starts live mode). Tick a box only after doing the thing yourself, not because
someone told you it's done.

## Research
- [ ] The strategy beat the random-entry baseline AND buy-and-hold on a risk-adjusted basis, in walk-forward testing (report linked in research/experiments.md)
- [ ] It still worked with costs doubled (2x costs)
- [ ] The locked holdout period was run once and the result was acceptable
- [ ] The deflated Sharpe ratio (adjusted for every variant we tried) was still positive

## Paper trading
- [ ] Paper trading ran for at least 1 month on the Trading 212 demo account
- [ ] Paper results roughly matched the backtest over the same days (fills, slippage, number of trades, PnL)

## Safety controls, each tested for real on the demo account
- [ ] `samsulek kill` cancelled open orders and stopped the bot
- [ ] `samsulek kill --flatten` closed all positions
- [ ] A forced daily-loss halt stopped trading, and only `samsulek reset-halt` at my own terminal resumed it
- [ ] A deliberate local-vs-broker mismatch halted trading and sent an alert
- [ ] Stale or missing data halted trading and sent an alert
- [ ] Telegram alerts reached my phone, and the Telegram /kill command worked

## Accounts and secrets
- [ ] I created the LIVE API key myself, with the minimum permissions needed, and it exists only on my own computer
- [ ] I never pasted any key, password, or seed phrase into a chat
- [ ] Two-factor authentication is enabled on my Trading 212 account
- [ ] config/risk.yaml has tiny live limits, and I have read every limit

## Me
- [ ] I deposited only money I can afford to lose completely
- [ ] I know how to stop everything: `samsulek kill --flatten`, or closing positions in the Trading 212 app

Signed-off-by:
Date:
