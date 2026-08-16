import { ytId, flattenVideoUrls, flattenCourseVideosWithTitles } from "./text.js";

function getVideosRoot(state) {
  let videosRoot = state.videos;
  if (!videosRoot && state.course && typeof state.course === "object") {
    videosRoot = state.course.videos || state.course.weeks;
  }
  if (!videosRoot) videosRoot = state.weeks;
  return videosRoot;
}

export async function deriveVideoNumberFromCourse(db, uid, courseTitle, videoUrl) {
  if (!uid || !courseTitle || !videoUrl) return [null, null];
  const targetId = ytId(videoUrl) || videoUrl.trim();

  const state = await db.collection("course_states").findOne(
    { uid, courseTitle },
    { projection: { videos: 1, weeks: 1, course: 1 } }
  );
  if (!state) return [null, null];

  const flattened = flattenVideoUrls(getVideosRoot(state));
  if (!flattened.length) return [null, null];

  const total = flattened.length;
  for (let i = 0; i < flattened.length; i++) {
    const vid = ytId(flattened[i]) || flattened[i].trim();
    if (vid && targetId && vid === targetId) return [i + 1, total];
  }
  return [null, total];
}

export async function deriveVideoMetaFromCourse(db, uid, courseTitle, videoUrl) {
  if (!uid || !courseTitle || !videoUrl) return [null, null, null];
  const targetId = ytId(videoUrl) || videoUrl.trim();

  const state = await db.collection("course_states").findOne(
    { uid, courseTitle },
    { projection: { videos: 1, weeks: 1, course: 1 } }
  );
  if (!state) return [null, null, null];

  const entries = flattenCourseVideosWithTitles(getVideosRoot(state));
  if (!entries.length) return [null, null, null];

  const total = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const vurl = (entries[i].url || "").trim();
    const vid = ytId(vurl) || vurl;
    if (vid && targetId && vid === targetId) return [i + 1, total, entries[i].title || `Video ${i + 1}`];
  }
  return [null, total, null];
}

export async function deriveCourseTitleFromVideo(db, uid, videoUrl) {
  if (!uid || !videoUrl) return null;
  const states = await db
    .collection("course_states")
    .find({ uid }, { projection: { _id: 0, courseTitle: 1, videos: 1 } })
    .toArray();

  for (const st of states) {
    const vids = st.videos;
    const urls = flattenVideoUrls(vids);
    if (urls.includes(videoUrl)) return st.courseTitle;
  }
  return null;
}

export async function isCourseHeld(db, uid, courseTitle) {
  if (!uid || !courseTitle) return false;
  try {
    const doc = await db.collection("course_holds").findOne(
      { uid, courseTitle },
      { projection: { _id: 0, held: 1 } }
    );
    return !!(doc || {}).held;
  } catch {
    return false;
  }
}

export async function blockIfHeld(db, uid, courseTitle) {
  if (await isCourseHeld(db, uid, courseTitle)) {
    return { error: "This course is currently on hold by admin.", status: 403 };
  }
  return null;
}
