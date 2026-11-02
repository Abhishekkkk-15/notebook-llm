import { connectMongo } from "./mongo.js";
import { ProjectModel, type IProjectDoc } from "./project.model.js";

export class MongoProjectStore {
  private static indexesEnsured = false;

  private async ensureConnected(): Promise<void> {
    await connectMongo();
    if (!MongoProjectStore.indexesEnsured) {
      try {
        await ProjectModel.createIndexes();
        MongoProjectStore.indexesEnsured = true;
      } catch (err) {
        console.warn("[MongoDB] Warning while ensuring Project indexes:", err);
      }
    }
  }

  async createOrUpdateProject(
    data: Partial<IProjectDoc> & { projectId: string; name: string },
  ): Promise<IProjectDoc> {
    await this.ensureConnected();

    const doc = await ProjectModel.findOneAndUpdate(
      { projectId: data.projectId },
      { $set: data },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

    return doc!;
  }

  async getProject(projectId: string): Promise<IProjectDoc | null> {
    await this.ensureConnected();
    return ProjectModel.findOne({ projectId }).lean();
  }

  async listProjects(): Promise<IProjectDoc[]> {
    await this.ensureConnected();
    return ProjectModel.find().sort({ updatedAt: -1 }).lean();
  }

  async deleteProject(projectId: string): Promise<boolean> {
    await this.ensureConnected();
    const res = await ProjectModel.deleteOne({ projectId });
    return res.deletedCount > 0;
  }
}

export const mongoProjectStore = new MongoProjectStore();
