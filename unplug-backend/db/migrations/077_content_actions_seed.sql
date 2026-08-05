-- Participation Engine — Stage G: seed the first real site action.
--
-- Stages A-F deliberately avoided seeding content-specific actions
-- (article_read, top10_vote, etc.) until something on the actual site
-- called them — otherwise there'd be participation_actions rows for
-- events nothing could ever trigger. This is the first real hookup:
-- voting in the Top 10 (see castVote() in unplug-magazine.html) now
-- also earns the signed-in voter points, via the generic
-- POST /participation/action route.
INSERT INTO participation_actions (code, label, category_code, content_type, base_points, daily_limit, weekly_limit, unique_per_object, counts_for_active_month, counts_as_meaningful)
VALUES ('top10_vote', 'Vote in the Top 10', 'competitive', 'top10', 8, 10, 30, TRUE, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;
