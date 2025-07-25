import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Workspace } from './models/workspace.model';
import { User } from 'src/user/user.model';
import { failure, success } from 'src/utils/response.helper';
import { WorkspaceMember } from './models/workspaceMemeber.model';
import { UpdateWorkspaceDto } from './dto/updateWorkspace.dto';
import { CryptUtil } from 'src/utils/crypt.util';
import { Message } from 'src/message/message.model';
import { MessageRead } from 'src/message/messageRead.model';
import { Sequelize } from 'sequelize-typescript';
import { Op } from 'sequelize';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly sequelize: Sequelize,
    @InjectModel(Workspace) private workspaceModel: typeof Workspace,
    @InjectModel(WorkspaceMember) private workspaceMemberModel: typeof WorkspaceMember,
    @InjectModel(Message) private messageModel: typeof Message,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(MessageRead) private messageReadModel: typeof MessageRead,
  ) { }

  async search(params: {
    userId: string;
    pageNo: number;
    pageSize: number;
    senderId: string;
    type: string;
    query: string;
    workspaceId: string;
  }) {
    const {
      pageNo,
      pageSize,
      senderId,
      type,
      query,
      workspaceId,
    } = params;

    const where: Record<string, any> = {};

    if (!workspaceId) {
      throw new ForbiddenException("workspaceId is required");
    } else {
      where.workspaceId = workspaceId;
    }
    if (senderId) where.senderId = senderId;
    if (type) where.type = type;
    if (query) where.message_text = { [Op.like]: `%${query}%` };

    where.isDelete = false;

    const options: any = {
      where,
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: User,
          as: 'Sender',
          attributes: ['id', 'name', 'email', 'imageUrl']
        },
         {
          model: User,
          as: 'Receiver',
          attributes: ['id', 'name', 'email', 'imageUrl']
        }
      ]
    };

    if (pageNo && pageSize) {
      const page = parseInt(pageNo as any, 10);
      const limit = parseInt(pageSize as any, 10);
      options.offset = (page - 1) * limit;
      options.limit = limit;
    }

    const { count, rows } = await this.messageModel.findAndCountAll(options);

    return success('Fetch Successfully', rows, {
      ...(pageNo && pageSize
        ? { pageNo: Number(pageNo), pageSize: Number(pageSize) }
        : {}),
      total: count,
    });
  }


  async getAllPublicWorkspaces(req: any, pageNo?: number, pageSize?: number) {
    const userId = req.user.id
    try {
      const where = { type: 'public' };

      const totalCount = await this.workspaceModel.count({ where });

      const queryOptions: any = {
        where,
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'name', 'email', 'imageUrl'],
          },
          {
            model: Message,
            as: 'messages',
            attributes: [
              'message_text',
              'SenderId',
              'workspaceId',
              'type',
              'timestamp',
              'read',
              'isDelete'
            ],
            separate: true,
            limit: 1,
            order: [['timestamp', 'DESC']],
          },
          {
            model: WorkspaceMember,
            as: 'members',
            include: [
              {
                model: User,
                as: 'member',
                attributes: ['id', 'name', 'email', 'imageUrl'],
              },
            ],
          },
        ],
      };

      if (pageNo && pageSize) {
        queryOptions.limit = pageSize;
        queryOptions.offset = (pageNo - 1) * pageSize;
      }

      const publicWorkspaces = await this.workspaceModel.findAll(queryOptions);

      const allUnreadedCount = await Promise.all(
        publicWorkspaces.map(w => this.getWorkspaceUnreadCount(w.id, userId))
      );

      const transformed = publicWorkspaces.map(workspace => {
        const w = workspace.toJSON();

        const unreadInfo = allUnreadedCount.find(
          u => u.workspaceId === w.id
        );

        w.unreadedCount = unreadInfo ? unreadInfo.unreadedCount : 0;

        w.lastMessage = w.messages?.[0] || null;

        delete w.messages;

        return w;
      });


      return success(
        'Private Workspaces fetched successfully',
        transformed,
        {
          totals: totalCount,
          ...(pageNo && pageSize
            ? { pageNo, pageSize }
            : {}),
        }
      );


    } catch (error) {
      return failure(error.message || 'Failed to fetch public workspaces');
    }
  }

  async createPublicWorkspace(req: any, name: string) {
    const userId = req.user.id
    try {
      const newWorkspace = await this.workspaceModel.create({
        id: CryptUtil.generateId(),
        name,
        type: 'public',
        createdBy: userId,
      });

      await this.workspaceMemberModel.create({
        id: CryptUtil.generateId(),
        workspaceId: newWorkspace.id,
        userId: userId,
        type: 'admin',
      });

      return success('Public workspace created successfully', newWorkspace);
    } catch (error) {
      return failure(error.message || 'Failed to create public workspace');
    }
  }

  async addUserToWorkspace(req: any, workspaceId: string, userId: string) {
    const reqUserId = req.user.id;

    try {
      const workspace = await this.workspaceModel.findByPk(workspaceId);

      if (!workspace) {
        return failure(`Workspace not found`);
      }

      const workspaceType = workspace.type;

      // If private, require admin to add
      if (workspaceType === 'private') {
        const isAdmin = await this.workspaceMemberModel.findOne({
          where: {
            workspaceId,
            userId: reqUserId,
            type: 'admin',
          },
        });

        if (!isAdmin) {
          return failure('Only Admin can add members to a private workspace');
        }
      }

      const existingMember = await this.workspaceMemberModel.findOne({
        where: {
          workspaceId,
          userId,
          isRemoved: false,
        },
      });

      if (existingMember) {
        return failure(`User is already a member of the workspace`);
      }

      let memberToReturn;

      const softDeletedMember = await this.workspaceMemberModel.findOne({
        where: {
          workspaceId,
          userId,
          isRemoved: true,
        },
      });

      if (softDeletedMember) {
        softDeletedMember.isRemoved = false;
        await softDeletedMember.save();
        memberToReturn = softDeletedMember;
      } else {
        const newMember = await this.workspaceMemberModel.create({
          id: CryptUtil.generateId(),
          workspaceId,
          userId,
          type: 'member',
        });
        memberToReturn = newMember;
      }

      return success(
        `User added to ${workspaceType} workspace successfully`,
        memberToReturn,
      );

    } catch (error) {
      throw new InternalServerErrorException(error?.message || error);
    }
  }

  async getAllPrivateWorkspaces(pageNo?: number, pageSize?: number) {
    try {
      const where = { type: 'private' };

      const totalCount = await this.workspaceModel.count({ where });

      const queryOptions: any = {
        where,
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'name', 'email', 'imageUrl'],
          },
          {
            model: WorkspaceMember,
            as: 'members',
            include: [
              {
                model: User,
                as: 'member',
                attributes: ['id', 'name', 'email', 'imageUrl'],
              },
            ],
          },
        ],
      };

      if (pageNo && pageSize) {
        queryOptions.limit = pageSize;
        queryOptions.offset = (pageNo - 1) * pageSize;
      }

      const publicWorkspaces = await this.workspaceModel.findAll(queryOptions);

      return success(
        'Private Workspaces fetched successfully',
        publicWorkspaces,
        {
          totals: totalCount,
          ...(pageNo && pageSize
            ? { pageNo, pageSize }
            : {}),
        }
      );
    } catch (error) {
      return failure(error.message || 'Failed to fetch private workspaces');
    }
  }

  async createPrivateWorkspace(req: any, name: string) {
    const userId = req.user.id
    try {
      const newWorkspace = await this.workspaceModel.create({
        id: CryptUtil.generateId(),
        name,
        type: 'private',
        createdBy: userId,
      });

      await this.workspaceMemberModel.create({
        id: CryptUtil.generateId(),
        workspaceId: newWorkspace.id,
        userId: userId,
        type: 'admin',
      });

      return success('Private workspace created successfully', newWorkspace);
    } catch (error) {
      return failure(error.message || 'Failed to create private workspace');
    }
  }

  async getUserPrivateWorkspaces(req: any, pageNo?: number, pageSize?: number) {
    const userId = req.user.id
    try {
      const where = { type: 'private' };

      const totalCount = await this.workspaceModel.count({
        where,
        include: [
          {
            model: WorkspaceMember,
            as: 'members',
            where: { userId, isRemoved: false },
          },
        ],
      });
      const queryOptions: any = {
        where,
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'name', 'email', 'imageUrl'],
          },
          {
            model: Message,
            as: 'messages',
            attributes: [
              'message_text',
              'SenderId',
              'workspaceId',
              'type',
              'timestamp',
              'read',
              'isDelete'
            ],
            separate: true,
            limit: 1,
            order: [['timestamp', 'DESC']],
          },
          {
            model: WorkspaceMember,
            as: 'members',
            where: { userId, isRemoved: false },
            include: [
              {
                model: User,
                as: 'member',
                attributes: ['id', 'name', 'email', 'imageUrl'],
              },
            ],
          },
        ],
      };

      if (pageNo && pageSize) {
        queryOptions.limit = pageSize;
        queryOptions.offset = (pageNo - 1) * pageSize;
      }

      const privateWorkspaces = await this.workspaceModel.findAll(queryOptions);

      const allUnreadedCount = await Promise.all(
        privateWorkspaces.map(w => this.getWorkspaceUnreadCount(w.id, userId))
      );

      const transformed = privateWorkspaces.map(workspace => {
        const w = workspace.toJSON();

        const unreadInfo = allUnreadedCount.find(
          u => u.workspaceId === w.id
        );

        w.unreadedCount = unreadInfo ? unreadInfo.unreadedCount : 0;

        w.lastMessage = w.messages?.[0] || null;

        delete w.messages;

        return w;
      });


      return success(
        'Private Workspaces fetched successfully',
        transformed,
        {
          totals: totalCount,
          ...(pageNo && pageSize
            ? { pageNo, pageSize }
            : {}),
        }
      );

    } catch (error) {
      return failure(error.message || 'Failed to fetch private workspaces');
    }
  }

  async getWorkspaceById(req: any, id: string) {
    const userId = req?.user?.id ?? null;

    const singleWorkspace = await this.workspaceModel.findOne({
      where: { id },
      include: [
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'name', 'email', 'imageUrl'],
        },
        {
          model: WorkspaceMember,
          as: 'members',
          include: [
            {
              model: User,
              as: 'member',
              attributes: ['id', 'name', 'email', 'imageUrl'],
            },
          ],
        },
      ],
    });

    if (!singleWorkspace) {
      return failure('Workspace not found');
    }

    let isMember = false;
    const plainWorkspace = singleWorkspace.toJSON();
    if (userId && plainWorkspace.members) {
      isMember = plainWorkspace.members.some(
        (m) => m.userId === userId && m.userId === userId && m.isRemoved === false
      );
    }

    return success('Workspace fetched successfully', {
      workspace: singleWorkspace,
      isMember: userId ? isMember : undefined,
    });
  }

  async updateWorkspaceById(req: any, id: string, updateWorkspaceDto: UpdateWorkspaceDto) {
    try {
      const userId = req.user.id

      const workspace = await this.workspaceModel.findOne({
        where: { id },
      });

      if (!workspace) {
        throw new NotFoundException('Workspace not found');
      }

      const isAdmin = await this.workspaceMemberModel.findOne({
        where: { workspaceId: id, userId, type: 'admin' },
      });

      if (!isAdmin) {
        throw new ForbiddenException('You are not allowed to update this workspace');
      }

      await workspace.update(updateWorkspaceDto);

      return success('Workspace updated successfully', {
        workspace: workspace.toJSON(),
      });
    } catch (error) {
      throw new InternalServerErrorException(error)
    }
  }

  async deleteWorkspaceById(req: any, workspaceId: string) {
    const userId = req.user.id;

    const workspace = await this.workspaceModel.findOne({
      where: { id: workspaceId },
      include: [
        {
          model: WorkspaceMember,
          as: 'members',
          attributes: ['userId', 'type'],
          include: [{
            model: User,
            as: "member"
          }]
        },
      ],
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const plainWorkspace = workspace.toJSON();

    const isCreator = plainWorkspace.createdBy === userId;

    const isAdmin = plainWorkspace.members.some(
      (m) => m.userId === userId && m.role === 'admin',
    );

    if (!isCreator && !isAdmin) {
      throw new ForbiddenException(
        'Only the creator or an admin can delete this workspace',
      );
    }

    await workspace.destroy();

    return success('Workspace deleted successfully', workspace);
  }

  async deleteWorkspaceMember(req: any, workspaceId: string, memberId: string) {
    const userId = req.user.id
    const member = await this.workspaceMemberModel.findOne({
      where: { workspaceId, userId: memberId },
    });

    if (!member) {
      throw new NotFoundException('Member not found in this workspace');
    }

    const workspace = await this.workspaceModel.findOne({ where: { id: workspaceId } });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.createdBy !== userId && userId !== memberId) {
      throw new ForbiddenException('You are not allowed to remove this member');
    }

    // await member.destroy();

    return success('Member removed successfully', member);
  }

  // chat related methods

  async uploadMessageFile(
    senderId: string,
    workspaceId: string,
    type: 'audio' | 'video' | 'image',
    fileUrl?: string
  ) {
    try {
      const isMember = await this.workspaceMemberModel.findOne({
        where: { userId: senderId, isRemoved: false },
      });

      if (!isMember) {
        throw new ForbiddenException('You are not a member of this workspace');
      }

      if (!fileUrl) {
        throw new BadRequestException('No file URL provided');
      }

      return success('File Uploaded Successfully', {
        fileUrl,
        senderId,
        workspaceId,
        type,
      });
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException(
        err.message || 'Failed to upload message file'
      );
    }
  }

  async sendMessage(senderId: string, workspaceId: string, content: string, type?: 'text' | 'audio' | 'video' | 'image', fileUrl?: string) {

    const workspace = await this.workspaceModel.findOne({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const isMember = await this.workspaceMemberModel.findOne({
      where: { workspaceId, userId: senderId, isRemoved: false },
    });

    if (!isMember) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    const data: any = {
      id: `workspace-msg-${Date.now()}-${CryptUtil.generateId()}`,
      workspaceId: workspace.id,
      SenderId: senderId,
      message_text: content,
      type: type ?? 'text',
    };

    if (fileUrl) {
      data.message_file_url = fileUrl;
    }

    const message = await this.messageModel.create(data);
    return success("Message Created Successfully", message);
  }

  async getWorkspaceChats(
    req: any,
    id: string,
    pageNo?: number,
    pageSize?: number
  ) {
    const userId = req.user.id;

    const isMember = await this.workspaceMemberModel.findOne({
      where: { workspaceId: id, userId, isRemoved: false },
    });

    if (!isMember) {
      throw new ForbiddenException('You are not a member of this workspace');
    }

    const singleWorkspace = await this.workspaceModel.findOne({
      where: { id },
      include: [
        {
          model: this.userModel,
          as: 'creator',
          attributes: ['id', 'name', 'email', 'imageUrl'],
        },
      ],
    });

    if (!singleWorkspace) {
      return failure('Workspace not found');
    }

    const totalCount = await this.messageModel.count({
      where: { workspaceId: id },
    });

    const messageQuery: any = {
      where: { workspaceId: id },
      order: [['timestamp', 'DESC']],
    };

    if (pageNo && pageSize) {
      messageQuery.limit = pageSize;
      messageQuery.offset = (pageNo - 1) * pageSize;
    }

    const members = await this.workspaceMemberModel.findAll({
      where: { workspaceId: id },
      attributes: ['userId'],
    });
    const memberIds = members.map(m => m.userId);

    const messages = await this.messageModel.findAll({
      ...messageQuery,
      include: [
        {
          model: User,
          as: 'Sender',
          attributes: ['id', 'name', 'email', 'imageUrl'],
        },
        {
          model: MessageRead,
          as: 'messageReads',
          attributes: ['userId', 'readAt'],
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'name', 'email', 'imageUrl'],
            },
          ],
        },
      ],
    });

    const enrichedMessages = messages.map(msg => {
      const msgJSON = msg.toJSON();
      const readers = msgJSON.messageReads.map(r => r.userId);
      const allRead = memberIds.every(mid => readers.includes(mid));
      return {
        ...msgJSON,
        allRead,
      };
    });

    const workspace = singleWorkspace.toJSON();
    workspace.messages = enrichedMessages;

    return success(
      'Workspace fetched successfully',
      workspace,
      {
        totalCount,
        ...(pageNo && pageSize
          ? { pageNo, pageSize }
          : {}),
      }
    );
  }

  async getWorkspaceUnreadCount(workspaceId: string, userId: string) {
    try {
      const unreadMessages = await this.messageModel.findAll({
        where: { workspaceId },
        include: [
          {
            model: this.messageReadModel,
            as: 'messageReads',
            required: false,
            where: { userId },
          },
          {
            model: this.workspaceModel,
            attributes: ['id', 'name']
          },
        ],
        group: ['Message.id'],
        having: Sequelize.literal('COUNT(`messageReads`.`id`) = 0'),
      });
      return { unreadedCount: unreadMessages.length, workspaceId };

    } catch (error) {
      console.error('Error getting unread count:', error);
      throw error;
    }
  }

  async getWorkspaceMembers(userId: string, workspaceId: string, pageNo?: number, pageSize?: number) {
    try {
      const workspace = await Workspace.findByPk(workspaceId);
      if (!workspace) throw new NotFoundException('Workspace not found');

      const isMember = await WorkspaceMember.findOne({ where: { workspaceId, userId, isRemoved: false } });
      if (!isMember) throw new ForbiddenException('You are not a member of this workspace');

      const where = { workspaceId };

      const queryOptions: any = {
        where,
        include: [
          {
            model: User,
            attributes: ['id', 'name', 'email', 'imageUrl'],
          }
        ],
        attributes: ['id', 'type', 'isRemoved']
      };

      if (pageNo && pageSize) {
        queryOptions.limit = pageSize;
        queryOptions.offset = (pageNo - 1) * pageSize;
      }

      const members = await WorkspaceMember.findAll(queryOptions);
      const totalCount = await WorkspaceMember.count({ where, distinct: true });

      return success(
        'Members fetched successfully',
        members,
        {
          total: totalCount,
          ...(pageNo && pageSize ? { pageNo, pageSize } : {}),
        }
      );
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) throw error;
      throw new InternalServerErrorException(error?.message || 'Something went wrong');
    }
  }

  async updateWorkspacePicture(
    id: string,
    req: any,
    imageUrl: string | null,
  ) {
    const userId = req.user.id;

    const isAdmin = await this.workspaceMemberModel.findOne({
      where: { workspaceId: id, userId, type: 'admin' },
    });

    if (!isAdmin) {
      throw new ForbiddenException('You are not an admin of this workspace');
    }
    const workspace = await this.workspaceModel.findByPk(id);

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (imageUrl === null) {
      throw new NotFoundException('image not found');
    }

    workspace.imageUrl = imageUrl;

    await workspace.save();

    return workspace;
  }

  async toggleUpdateMemberType(
    memberId: string,
    currentUserId: string,
  ) {
    try {
      const member = await this.workspaceMemberModel.findByPk(memberId);

      if (!member) {
        throw new NotFoundException('Workspace member not found');
      }

      const isAdmin = await this.workspaceMemberModel.findOne({
        where: {
          workspaceId: member.workspaceId,
          userId: currentUserId,
          type: 'admin',
        },
      });

      if (!isAdmin) {
        throw new ForbiddenException('You are not an admin of this workspace');
      }

      if (member.type === 'admin') {
        const adminCount = await this.workspaceMemberModel.count({
          where: {
            workspaceId: member.workspaceId,
            type: 'admin',
          },
        });

        if (adminCount <= 1) {
          throw new ForbiddenException(
            'Cannot remove the last admin from the workspace',
          );
        }

        member.type = 'member';
      } else {
        member.type = 'admin';
      }

      await member.save();

      return success("Member Type Changed Successfully", member)
    } catch (error) {
      throw new InternalServerErrorException(error)
    }
  }

  async deleteMemberById(memberId: string, currentUserId: string) {
    const member = await this.workspaceMemberModel.findByPk(memberId);

    if (!member) {
      throw new NotFoundException('Workspace member not found');
    }

    const isAdmin = await this.workspaceMemberModel.findOne({
      where: {
        workspaceId: member.workspaceId,
        userId: currentUserId,
        type: 'admin',
      },
    });

    if (!isAdmin) {
      throw new ForbiddenException('You are not an admin of this workspace');
    }

    member.isRemoved = true;

    await member.save();

    return {
      message: 'Member deleted successfully',
      data: member,
    };
  }

  async leaveWorkspaceById(workspaceId: string, userId: string) {
    const transaction = await this.sequelize.transaction();

    try {
      const member = await this.workspaceMemberModel.findOne({
        where: { workspaceId, userId, isRemoved: false },
        transaction,
      });

      if (!member) {
        throw new NotFoundException('Workspace member not found');
      }

      const isAdmin = member.type === 'admin';

      if (isAdmin) {
        // Check if any other admin exists
        const otherAdmin = await this.workspaceMemberModel.findOne({
          where: {
            workspaceId,
            userId: { [Op.ne]: userId },
            type: 'admin',
            isRemoved: false,
          },
          transaction,
        });

        if (!otherAdmin) {
          // No other admin — promote a random member to admin
          const randomMember = await this.workspaceMemberModel.findOne({
            where: {
              workspaceId,
              userId: { [Op.ne]: userId },
              isRemoved: false,
            },
            order: this.sequelize.random(),
            transaction,
          });

          if (randomMember) {
            randomMember.type = 'admin';
            await randomMember.save({ transaction });
          } else {
            throw new BadRequestException(
              'Cannot leave workspace. No other members to promote to admin.'
            );
          }
        }
      }

      member.isRemoved = true;
      await member.save({ transaction });

      await transaction.commit();

      return success('Left workspace successfully', member)
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  async editMessage(userId: string, id: string, message_text: string) {

    try {
      const message = await this.messageModel.findByPk(id, {
        attributes: [
          'id',
          'SenderId',
          'workspaceId',
          'editCount',
          'editAt',
          'isDelete',
          'type',
          'createdAt',
        ],
      });

      if (!message) {
        throw new NotFoundException('Message Not Found');
      }

      if (message.SenderId !== userId || message.isDelete || message.type != 'text') {
        throw new ForbiddenException("You can't edit this message");
      }

      const createdAt = new Date(message.createdAt);
      const now = new Date();
      const diffMs = now.getTime() - createdAt.getTime();
      const diffMins = diffMs / (1000 * 60);

      if (diffMins > 15) {
        throw new ForbiddenException('You can no longer edit this message (time limit exceeded)');
      }

      message.message_text = message_text;
      message.editCount += 1;
      message.editAt = now;

      await message.save();

      return success('Message Edited Successfully', message);

    } catch (error) {
      throw new InternalServerErrorException(error);
    }
  }

  async deleteMessage(userId: string, id: string) {
    try {
      const message = await this.messageModel.findByPk(id, {
        attributes: [
          'id',
          'isDelete',
          "SenderId"
        ],
      });

      if (!message) {
        throw new NotFoundException('Message Not Found');
      }

      if (message.SenderId !== userId || message.isDelete) {
        throw new ForbiddenException({
          ms: `You can't edit this message`,
          userId,
          message
        });
      }

      message.isDelete = true;

      await message.save();

      return success('Message deleted Successfully', message);

    } catch (error) {
      throw new InternalServerErrorException(error);
    }
  }
}
