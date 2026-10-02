import { SetMetadata, applyDecorators } from '@nestjs/common';
import { AdminAction, Action, ResourceType } from '../permission/types';

export const ACTOR_KEY = 'actor';
export const ADMIN_ACTION_KEY = 'adminAction';
export const PERMISSION_KEY = 'permissionRequirement';

export interface PermissionRequirement {
  action: Action;
  resourceType: ResourceType;
  /** 路由参数名，其值即资源主键 */
  param: string;
}

export const RequirePermission = (
  action: Action,
  resourceType: ResourceType,
  param = 'id',
) => applyDecorators(SetMetadata(PERMISSION_KEY, { action, resourceType, param } satisfies PermissionRequirement));

export const RequireAdmin = (action: AdminAction) => SetMetadata(ADMIN_ACTION_KEY, action);
