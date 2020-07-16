/**
 * Copyright 2020 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const _ = require('lodash');
const { v4: UUID } = require('uuid');
const {  ValidationError } = require('apollo-server');

const { ACTIONS, TYPES } = require('../models/const');
const { whoIs, validAuth, NotFoundError } = require ('./common');
const { GraphqlPubSub } = require('../subscription');
const GraphqlFields = require('graphql-fields');

const pubSub = GraphqlPubSub.getInstance();

const applyQueryFieldsToGroups = async(groups, queryFields, { orgId }, models)=>{
  if(queryFields.owner){
    const owners = await models.User.getBasicUsersByIds(_.uniq(_.map(groups, 'owner')));
    var ownersById = _.groupBy(owners, 'id');
    _.each(groups, (group)=>{
      group.owner = ownersById[group.owner];
    });
  }
  if(queryFields.subscriptions || queryFields.subscriptionCount){
    var groupNames = _.uniq(_.map(groups, 'name'));
    const subscriptions = await models.Subscription.find({ org_id: orgId, groups: { $in: groupNames } }).lean({ virtuals: true });
    const subscriptionsByGroupName = {};
    _.each(subscriptions, (sub)=>{
      _.each(sub.groups, (groupName)=>{
        subscriptionsByGroupName[groupName] = subscriptionsByGroupName[groupName] || [];
        subscriptionsByGroupName[groupName].push(sub);
      });
    });
    _.each(groups, (group)=>{
      group.subscriptions = subscriptionsByGroupName[group.name] || [];
      group.subscriptionCount = group.subscriptions.length;
    });
  }
  if(queryFields.clusters || queryFields.clusterCount){
    var groupUuids = _.uniq(_.map(groups, 'uuid'));
    const clusters = await models.Cluster.find({ org_id: orgId, 'groups.uuid': { $in: groupUuids } }).lean({ virtuals: true });
    const clustersByGroupUuid = {};
    _.each(clusters, (cluster)=>{
      _.each(cluster.groups || [], (groupObj)=>{
        clustersByGroupUuid[groupObj.uuid] = clustersByGroupUuid[groupObj.uuid] || [];
        clustersByGroupUuid[groupObj.uuid].push(cluster);
      });
    });
    _.each(groups, (group)=>{
      group.clusters = clustersByGroupUuid[group.uuid] || [];
      group.clusterCount = group.clusters.length;
    });
  }
};

const groupResolvers = {
  Query: {
    groups: async(parent, { orgId }, context, fullQuery) => {
      const queryFields = GraphqlFields(fullQuery);
      const { models, me, req_id, logger } = context;
      const queryName = 'groups';
      logger.debug({req_id, user: whoIs(me), orgId }, `${queryName} enter`);
      await validAuth(me, orgId, ACTIONS.READ, TYPES.GROUP, queryName, context);
      let groups;
      try{
        groups = await models.Group.find({ org_id: orgId }).lean({ virtuals: true });

        await applyQueryFieldsToGroups(groups, queryFields, { orgId }, models);

        return groups;
      }catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },
    group: async(parent, { orgId, uuid }, context, fullQuery) => {
      const queryFields = GraphqlFields(fullQuery);
      const { models, me, req_id, logger } = context;
      const queryName = 'group';
      logger.debug({req_id, user: whoIs(me), orgId, uuid}, `${queryName} enter`);
      await validAuth(me, orgId, ACTIONS.READ, TYPES.GROUP, queryName, context);
  
      try{
        let group = await models.Group.findOne({ org_id: orgId, uuid }).lean({ virtuals: true });
        if (!group) {
          throw new NotFoundError(`could not find group with uuid ${uuid}.`);
        }

        await applyQueryFieldsToGroups([group], queryFields, { orgId }, models);

        return group;
      }catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },
    groupByName: async(parent, { orgId, name }, context, fullQuery) => {
      const queryFields = GraphqlFields(fullQuery);
      const { models, me, req_id, logger } = context;
      const queryName = 'groupByName';
      logger.debug({req_id, user: whoIs(me), orgId, name}, `${queryName} enter`);
      await validAuth(me, orgId, ACTIONS.READ, TYPES.GROUP, queryName, context);
  
      try{
        let group = await models.Group.findOne({ org_id: orgId, name }).lean({ virtuals: true });
        if (!group) {
          throw new NotFoundError(`could not find group with name ${name}.`);
        }

        await applyQueryFieldsToGroups([group], queryFields, { orgId }, models);

        return group;
      }catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },    
  },
  Mutation: {
    addGroup: async (parent, { orgId: org_id, name }, context)=>{
      const { models, me, req_id, logger } = context;
      const queryName = 'addGroup';
      logger.debug({ req_id, user: whoIs(me), org_id, name }, `${queryName} enter`);
      await validAuth(me, org_id, ACTIONS.MANAGE, TYPES.GROUP, queryName, context);
    
      try {
        // might not necessary with unique index. Worth to check to return error better.
        const group = await models.Group.findOne({ org_id: org_id, name });
        if(group){
          throw new ValidationError(`The group name ${name} already exists.`);
        }
        const uuid = UUID();
        await models.Group.create({
          _id: UUID(),
          uuid, org_id: org_id, name, owner: me._id,
        });

        pubSub.channelSubChangedFunc({org_id: org_id});

        return {
          uuid,
        };
      } catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },

    removeGroup: async (parent, { orgId: org_id, uuid }, context)=>{
      const { models, me, req_id, logger } = context;
      const queryName = 'removeGroup';
      logger.debug({ req_id, user: whoIs(me), org_id, uuid }, `${queryName} enter`);
      await validAuth(me, org_id, ACTIONS.MANAGE, TYPES.GROUP, queryName, context);
  
      try{
        const group = await models.Group.findOne({ uuid, org_id: org_id }).lean();
        if(!group){
          throw new NotFoundError(`group uuid "${uuid}" not found`);
        }
  
        const subCount = await models.Subscription.count({ org_id: org_id, groups: group.name });
  
        if(subCount > 0){
          throw new ValidationError(`${subCount} subscriptions depend on this cluster group. Please update/remove them before removing this group.`);
        }
        
        const clusterIds = await models.Cluster.distinct('cluster_id', { org_id: org_id, 'groups.uuid': group.uuid });
        if(clusterIds && clusterIds.length > 0) {
          await groupResolvers.Mutation.unGroupClusters(parent, {orgId: org_id, uuid, clusters: clusterIds}, context);
        }

        await models.Group.deleteOne({ org_id: org_id, uuid:group.uuid });

        pubSub.channelSubChangedFunc({org_id: org_id});
  
        return {
          uuid: group.uuid,
          success: true,
        };
      } catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },

    removeGroupByName: async (parent, { orgId: org_id, name }, context)=>{
      const { models, me, req_id, logger } = context;
      const queryName = 'removeGroupByName';
      logger.debug({ req_id, user: whoIs(me), org_id, name }, `${queryName} enter`);
      await validAuth(me, org_id, ACTIONS.MANAGE, TYPES.GROUP, queryName, context);
  
      try{
        const group = await models.Group.findOne({ name, org_id: org_id }).lean();
        if(!group){
          throw new NotFoundError(`group name "${name}" not found`);
        }
  
        const subCount = await models.Subscription.count({ org_id: org_id, groups: group.name });
        if(subCount > 0){
          throw new ValidationError(`${subCount} subscriptions depend on this cluster group. Please update/remove them before removing this group.`);
        }

        const uuid = group.uuid;
        const clusterIds = await models.Cluster.distinct('cluster_id', { org_id: org_id, 'groups.uuid': group.uuid });
        if(clusterIds && clusterIds.length > 0) {
          await groupResolvers.Mutation.unGroupClusters(parent, {orgId: org_id, uuid, clusters: clusterIds}, context);
        }
        
        const clusterCount = await models.Cluster.count({ org_id: org_id, 'groups.uuid': group.uuid });
        if(clusterCount > 0){
          throw new ValidationError(`${clusterCount} clusters depend on this group. Please update/remove the group from the clusters.`);
        }      

        await models.Group.deleteOne({ org_id: org_id, uuid:group.uuid });

        pubSub.channelSubChangedFunc({org_id: org_id});
  
        return {
          uuid: group.uuid,
          success: true,
        };
      } catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },

    groupClusters: async (parent, { orgId: org_id, uuid, clusters }, context)=>{
      const { models, me, req_id, logger } = context;
      const queryName = 'groupClusters';
      logger.debug({ req_id, user: whoIs(me), uuid, clusters }, `${queryName} enter`);
      await validAuth(me, org_id, ACTIONS.MANAGE, TYPES.GROUP, queryName, context);

      try{

        // validate the group exits in the db first.
        const group = await models.Group.findOne({ org_id: org_id, uuid });
        if(!group){
          throw new NotFoundError(`group uuid "${uuid}" not found`);
        }

        // update clusters group array with the above group
        const res = await models.Cluster.updateMany(
          {org_id: org_id, cluster_id: {$in: clusters}, 'groups.uuid': {$nin: [uuid]}},
          {$push: {groups: {uuid: group.uuid, name: group.name}}});

        logger.debug({ req_id, user: whoIs(me), uuid, clusters, res }, `${queryName} exit`);
        pubSub.channelSubChangedFunc({org_id: org_id});
        return {modified: res.modifiedCount !== undefined ? res.modifiedCount : res.nModified };
  
      } catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },

    unGroupClusters: async (parent, { orgId: org_id, uuid, clusters }, context)=>{
      const { models, me, req_id, logger } = context;
      const queryName = 'unGroupClusters';
      logger.debug({ req_id, user: whoIs(me), uuid, clusters }, `${queryName} enter`);
      await validAuth(me, org_id, ACTIONS.MANAGE, TYPES.GROUP, queryName, context);

      try{

        // validate the group exits in the db first.
        const group = await models.Group.findOne({ org_id: org_id, uuid });
        if(!group){
          throw new NotFoundError(`group uuid "${uuid}" not found`);
        }

        // update clusters group array with the above group
        const res = await models.Cluster.updateMany(
          {org_id: org_id, cluster_id: {$in: clusters}, 'groups.uuid': {$in: [uuid]}}, 
          {$pull: {groups: {uuid}}});

        logger.debug({ req_id, user: whoIs(me), uuid, clusters, res }, `${queryName} exit`);
        pubSub.channelSubChangedFunc({org_id: org_id});
        return {modified: res.modifiedCount !== undefined ? res.modifiedCount : res.nModified };
  
      } catch(err){
        logger.error(err, `${queryName} encountered an error when serving ${req_id}.`);
        throw err;
      }
    },
  },
};

module.exports = groupResolvers;
