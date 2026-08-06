---
title: "Weekly Product Sync — Brightbill"
type: spotkanie
status: stable
updated: 2026-06-12
date: 2026-06-10
duration: 38 minutes
uczestnicy-nierozpoznani: Maya Lindqvist (maya@brightbill.app), Jonas Park (jonas@brightbill.app)
---

# Weekly Product Sync — Brightbill

**Date:** 2026-06-10T09:00:00.000Z
**Duration:** 38 minutes
**Attendees:** Maya Lindqvist (CEO/Product), Jonas Park (CTO)

---

**Maya Lindqvist** (0:02): Okay, weekly sync. Agenda: beta feedback from Atlas Fitness, the launch date, pricing, and then your infra stuff. Anything else?

**Jonas Park** (0:14): The designer question. We keep pushing it and the invoice templates still look like a tax form.

**Maya Lindqvist** (0:21): Right, that goes on the list. Let's start with Atlas. I had the call with Dana yesterday. Short version: they love the recurring invoices, they hate the client portal.

**Jonas Park** (0:36): Hate as in confusing, or hate as in broken?

**Maya Lindqvist** (0:40): Confusing. Dana said her gym members couldn't find the payment history at all. Three of them emailed her asking if they'd been charged twice. They hadn't — the portal just shows the retry attempts as separate line items.

**Jonas Park** (0:58): Ah. Yeah, that's the Stripe webhook thing. We log every payment_intent attempt as its own row. I can collapse retries into one entry with a status badge. That's maybe a day of work.

**Maya Lindqvist** (1:12): Do it this sprint, please. If our friendliest beta customer is getting support emails because of us, that's the opposite of the pitch. Second thing from Dana: she asked when we'll have the Android app.

**Jonas Park** (1:27): And you said?

**Maya Lindqvist** (1:29): I said never, for v1. And I want us to actually decide that today instead of keeping it vague. Every week we spend arguing about React Native is a week the web app doesn't improve. Eighty percent of her members pay from the email link anyway, not from any app.

**Jonas Park** (1:48): I'm fine cutting it. For the record I was never pushing for a full app — I wanted the PWA to not be embarrassing. Add-to-homescreen, offline invoice list, push notifications. That's two weeks, not two months.

**Maya Lindqvist** (2:04): Okay, that's a real distinction. Decision then: no native Android app in v1. PWA improvements go on the roadmap as a fast-follow after launch — not before. Agreed?

**Jonas Park** (2:16): Agreed. Logging it: Android cut from v1, PWA fast-follow.

**Maya Lindqvist** (2:22): Launch date. We said July 1 back in April. I don't believe in it anymore. With the portal fix, the onboarding emails, and the pricing page still not existing, July 1 means launching tired and broken.

**Jonas Park** (2:38): What are you proposing?

**Maya Lindqvist** (2:40): July 15. Two extra weeks. Not because the backlog needs two weeks — it needs six — but because July 15 still catches the summer billing cycle for the gyms and studios we're targeting.

**Jonas Park** (2:55): If we slip to July 15 I want a feature freeze on July 4. Nothing new after that, only bugs. Last time we "slipped to polish" we actually slipped to add three features.

**Maya Lindqvist** (3:08): Fair. Decision: launch July 15, feature freeze July 4. I'll update the plan doc after this call.

**Jonas Park** (3:16): Good. Pricing. You said you had a proposal.

**Maya Lindqvist** (3:20): Two tiers. Solo at $29 a month — one user, unlimited invoices, the portal. Studio at $79 — five users, recurring billing, the branded portal, priority support. No free tier; fourteen-day trial instead.

**Jonas Park** (3:38): What happened to the $49 middle tier from last week's draft?

**Maya Lindqvist** (3:42): I killed it. Three tiers for a two-person company is theater. Atlas would pick Studio at $79 without blinking — Dana said their current tool costs them $120 with the payment add-on. Our problem isn't price, it's that nobody knows we exist.

**Jonas Park** (3:59): I'd still cap Solo somewhere so heavy users upgrade. Unlimited invoices on the cheap tier makes the upgrade reason "number of seats" only.

**Maya Lindqvist** (4:10): Counter: invoice caps feel punitive for exactly the freelancers we want word-of-mouth from. Seats and the branded portal are cleaner upgrade triggers. Let's ship $29/$79 and revisit in September with real data.

**Jonas Park** (4:25): Fine, but it goes in the decisions log with the revisit date. September 15, pricing review.

**Maya Lindqvist** (4:32): Done. Designer. You said the invoice templates look like a tax form, and you're right. I talked to Priya Nair — she did the Loomfolk rebrand. She's free from June 23, four weeks, fixed fee of $4,800 for the invoice templates, the portal screens, and the marketing site polish.

**Jonas Park** (4:53): That's within what we said we'd spend on design this quarter. Does she work in Figma with dev handoff, or do we get PDFs and prayers?

**Maya Lindqvist** (5:01): Figma, with a component library. References from two startups I trust. I want to sign her this week so she starts right after the freeze planning.

**Jonas Park** (5:11): Then do it. Decision: Priya, four weeks from June 23, $4,800. You own the contract, I'll prep a staging account for her by June 20.

**Maya Lindqvist** (5:24): Infra. Your turn.

**Jonas Park** (5:26): Two things. First: I'm moving us off the single Postgres box to managed RDS this weekend. Sunday morning, maybe 20 minutes of downtime, beta users get an email Friday. After the Atlas incident I don't want us one disk failure away from losing invoice data.

**Maya Lindqvist** (5:44): Approved, and put the maintenance window on the status page. Second thing?

**Jonas Park** (5:49): Costs. We're at about $310 a month on infra now. RDS adds roughly $90. Fine for now, but if we sign more than ten studios we should look at reserved instances. Not a today problem, I just want it written down somewhere it won't vanish.

**Maya Lindqvist** (6:06): Put it in the ops notes with a check-in date of August 1. Okay, recap. One: portal retry display fix this sprint — you. Two: Android cut from v1, PWA fast-follow after launch. Three: launch July 15, feature freeze July 4 — I update the plan. Four: pricing $29 Solo, $79 Studio, no free tier, review September 15. Five: Priya signed this week, starts June 23 — me on contract, you on staging access by June 20. Six: RDS migration Sunday with Friday notice. Seven: infra cost check-in August 1.

**Jonas Park** (6:39): That's everything. One ask: can Dana be a launch case study? "Gym cuts billing admin from six hours to one" is a better headline than anything I'll write.

**Maya Lindqvist** (6:50): Already floated it — she's in if we approve the quote with her first. I'll draft it after the portal fix ships, so the story ends well.

**Jonas Park** (6:58): Then we're done. Same time next week.

**Maya Lindqvist** (7:01): Done. Thanks, Jonas.
