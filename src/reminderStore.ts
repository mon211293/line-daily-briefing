import { Firestore } from "@google-cloud/firestore";

const COLLECTION = "reminded-events";
const firestore = new Firestore();

/** 檢查某個行事曆事件實例是否已經提醒過(避免每 15 分鐘重複推播)。 */
export async function hasBeenNotified(eventId: string): Promise<boolean> {
  const doc = await firestore.collection(COLLECTION).doc(eventId).get();
  return doc.exists;
}

export async function markNotified(eventId: string): Promise<void> {
  const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await firestore.collection(COLLECTION).doc(eventId).set({ notifiedAt: new Date(), expireAt });
}
