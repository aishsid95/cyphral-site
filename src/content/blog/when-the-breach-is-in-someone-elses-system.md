---
title: "When the breach is in someone else's system"
description: "A hacking group says it holds data on almost every FBI agent and applicant, taken through a third-party jobs portal. The claim is unverified, but it shows why your customers have started asking about your security."
pubDate: 2026-09-25
author: "Aisha"
tags: ["supply chain", "cyber essentials", "patching", "data breach", "small business"]
readingTime: "5 min read"
---

On 22 September, the hacking group ShinyHunters told reporters it had data on almost every FBI agent and on everyone who had applied for a job there. The group said that meant names, home addresses, phone numbers and, in some cases, details of spouses. 404 Media was shown a sample and confirmed it contained agents' personal information.

The next day the FBI said it was aware of a criminal group claiming to have compromised FBIJobs.gov, its careers portal. It said it didn't yet know where the breach had happened: with a third party, or in its own systems. The group says it got in through a flaw in Oracle's PeopleSoft, the HR software behind the portal. Oracle hasn't responded to requests for comment.

Most of this is unconfirmed, and I wouldn't build advice on a hacker's say-so. But the outline of the story is worth five minutes of any small business owner's time, because it's the same outline as the emails your customers have started sending you.

## Forget "even the FBI gets hacked"

That's the version you'll see most often, and it's no use to anyone. It ends in a shrug. If the FBI can't stop it, what chance does a six-person firm have?

The useful version is smaller. If the group is telling the truth, the way in was a careers portal running on software the FBI didn't build. It wasn't one of the core systems anyone would think of as the crown jewels, even if the hackers now claim to have reached further once they were inside. It was a supplier's product, holding personal data, with a very large organisation's name on the front.

Every small business sits on one side of that arrangement, and usually both. You give your data to suppliers: payroll, accounts, your CRM, file storage, the recruitment site you used once three years ago and forgot about. Your customers give their data to you. When something goes wrong anywhere along that chain, the name in the headline is rarely the company that was actually breached.

## Why your customers started asking

That chain is the reason for all the due diligence questionnaires. Larger organisations worked out a while ago that they're only as secure as the people they buy from, so they push the question down the line. It isn't that they think you're careless. It's that your systems are now part of their risk.

This is why "we're too small to be a target" misses the point. You may well be too small to be worth attacking directly. But you're not too small to be the way into someone bigger, and you're definitely not too small to be asked about it before a contract gets signed.

## The patching question

One detail in this story cuts both ways, and it's worth slowing down on.

The group told 404 Media it used a zero-day, meaning a flaw nobody had a fix for yet. If that's true, no patching policy would have helped. You can't install an update that doesn't exist.

There's another possibility, though. In June, Oracle released a fix for a serious PeopleSoft flaw. ShinyHunters had already been exploiting it for about two weeks by then, mostly against universities. If that's the flaw used here, a fix had been available since June and wasn't applied in time. That's a very different lesson.

Nobody has said publicly which it was. Either way, it's the second kind that catches small businesses: the fix is out, and nobody gets round to installing it. That's why Cyber Essentials asks you to install high-risk and critical updates within 14 days, for operating systems and firmware as well as for applications. Under the rules that came in this April, missing either of those is an automatic fail.

## What you can actually do

You can't audit Oracle. You can do these four things, and they'll do more for you than worrying about the news.

**Write down what you use.** List every service that holds your data or your customers' data, including the free tools and the ones only one person signed up for. The list is nearly always longer than people expect. Switching off the things you no longer need is about the quickest security win there is.

**Turn on multi-factor authentication wherever it's offered.** A lot of the incidents that hit small businesses start with someone logging in with a real password. MFA stops most of those. It's also no longer optional for Cyber Essentials: if a cloud service you use offers MFA and you haven't switched it on, you fail.

**Patch what you're responsible for, and do it quickly.** Laptops mostly look after themselves these days. Routers, firewalls, browser extensions and desktop software often don't. Fourteen days is the standard, and it's a sensible one to hold yourself to.

**Ask your suppliers what your customers ask you.** Do you have Cyber Essentials, or something stronger? How would you tell me if you were breached? What of mine do you actually hold? A decent supplier will have the answers ready. If one gets prickly about being asked, that tells you something too.

## Where certification fits

Cyber Essentials won't make you unbreachable, and be wary of anyone who says it will. What it gives you is a short, recognised, government-backed answer to a question you're going to be asked more and more. It also holds you to the basics that stop everyday attacks: MFA, patching, access control, firewalls and secure configuration.

For most small firms, that's the right place to be. Beyond that, it comes down to proportion, and to being honest about what data you hold.

My job is getting businesses ready for Cyber Essentials. I don't certify anyone. The assessment itself is done independently, by a certification body, and that's how it should be. If a customer has started asking questions and you're not sure where you stand, I offer a free 30-minute gap check. It covers what would pass today, what wouldn't, and what the work would involve. [Book a call](/contact).

## Sources

- 404 Media, [ShinyHunters say they hold data on all FBI employees](https://www.404media.co/we-hacked-the-fbi-hackers-say-they-have-data-on-all-fbi-employees/), 22 September 2026
- Cybersecurity Dive, [FBI probes cyberattack tied to third-party jobs portal](https://www.cybersecuritydive.com/news/fbi-hack-shinyhunters-jobs-portal/831175/), 23 September 2026
- Forbes, [FBI "aggressively" investigating alleged hack](https://www.forbes.com/sites/antoniopequenoiv/2026/09/23/fbi-aggressively-investigating-alleged-hack-compromising-all-employees-personal-data/), 23 September 2026
- Cybersecurity Dive, [ShinyHunters linked to exploitation of critical flaw in Oracle PeopleSoft](https://www.cybersecuritydive.com/news/shinyhunters-exploitation-critical-flaw-oracle-peoplesoft/822796/), 12 June 2026
- IASME, [Changes to Cyber Essentials for April 2026](https://iasme.co.uk/articles/important-update-changes-to-cyber-essentials-for-april-2026/)
