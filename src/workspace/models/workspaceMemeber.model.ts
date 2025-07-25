import {
  Table,
  Column,
  Model,
  PrimaryKey,
  ForeignKey,
  BelongsTo,
  DataType,
  Default,
} from 'sequelize-typescript';
import { Workspace } from './workspace.model';
import { User } from 'src/user/user.model';

@Table
export class WorkspaceMember extends Model {
  @PrimaryKey
  @Column
  declare id: string;

  @Column({
    type: DataType.ENUM('admin', 'member'),
  })
  declare type: 'admin' | 'member';

  @Default(false)
  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
  })
  declare isRemoved: boolean;

  @ForeignKey(() => Workspace)
  @Column
  declare workspaceId: string;

  @ForeignKey(() => User)
  @Column
  declare userId: string;

  @BelongsTo(() => Workspace, { as: 'workspace', foreignKey: 'workspaceId' })
  workspace: Workspace;

  @BelongsTo(() => User, { as: 'member', foreignKey: 'userId' })
  member: User;
}
